import { buildInventoryViewData } from '../modules/inventory/utils/buildInventoryViewData';
import { summarizeInventoryProfit } from '../modules/inventory/utils/inventoryProfit';
import {
  currencyEquivalents,
  formatCurrencyEquivalentParts,
  formatCurrencyEquivalents,
  loadServiceCurrencyRates,
  mergeCurrencyRates,
  ratesFromCurrencies,
  type CurrencyRate
} from '../modules/inventory/utils/currencyEquivalents';
import { getWarehouseId, getAuthorizedWarehouseIds } from "../modules/warehouse/warehouseScope";
import { getLowStockThreshold, isLowStockProduct, sumAvailableStock } from "../modules/inventory/utils/lowStock";
import { buildInventoryCsv } from '../modules/inventory/utils/buildInventoryCsv';
import { resizeProductImage } from '../modules/inventory/utils/resizeProductImage';
import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, PackagePlus, AlertCircle, Search, ShieldCheck, X, DollarSign, Trash2, Edit, History, Package, PackageCheck, TrendingUp, Filter, Download, Plus, ArrowRightLeft, LayoutGrid, List, Settings2, Tag, Building2, Save, RefreshCw, Minus, ChevronDown, ChevronUp, ChevronRight, Check } from "lucide-react";
import { useStore } from "../store/useStore";
import { cn, generateId } from "../lib/utils";
import { Product, Category } from "../types";
import { InfoTooltip } from "../components/InfoTooltip";
import { PrintLabels } from "../components/PrintLabels";
import { ABCAnalysis } from "../components/ABCAnalysis";
import { RestockAlerts } from "../components/RestockAlerts";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { loadSaaSContext } from '../services/saas';
import { getActiveTenant } from '../services/tenant';
import { loadCompensationSettings } from '../services/team';
import { pushProductToSupabase } from '../services/supabaseSync';
import { canUsePlanFeature } from '../services/planAccess';
import PlanFeatureGate from '../components/PlanFeatureGate';
import "./team.css";

// Equivalente USD/EUR en líneas separadas: en columnas estrechas una sola
// línea con las dos divisas se desbordaba o se recortaba.
function EquivalentLines({ parts, className, title }: { parts: string[]; className?: string; title?: string }) {
  if (!parts.length) {
    return <div className={cn("text-[8px] font-bold text-muted", className)} title={title}>—</div>;
  }
  return (
    <div className={cn("flex flex-col leading-tight tabular-nums", className)} title={title}>
      {parts.map((part) => <span key={part} className="whitespace-nowrap">{part}</span>)}
    </div>
  );
}

export default function Inventory() {
  const { 
    products, inventory, branches, addProduct, updateProduct, 
    setInventoryQuantity, deleteProduct, deleteCategory,
    categories, batchDeleteProducts, batchUpdateProducts, getBaseCurrency, currencies,
    currentBranchId, addNotification, users, currentUser, receiptConfig
  } = useStore(useShallow((state) => ({ products: state.products, inventory: state.inventory, branches: state.branches, addProduct: state.addProduct, updateProduct: state.updateProduct, setInventoryQuantity: state.setInventoryQuantity, deleteProduct: state.deleteProduct, deleteCategory: state.deleteCategory, categories: state.categories, batchDeleteProducts: state.batchDeleteProducts, batchUpdateProducts: state.batchUpdateProducts, getBaseCurrency: state.getBaseCurrency, currencies: state.currencies, currentBranchId: state.currentBranchId, addNotification: state.addNotification, users: state.users, currentUser: state.currentUser, receiptConfig: state.receiptConfig })));
  const baseCurrency = getBaseCurrency();

  // Compensación global de la empresa: define el salario por unidad que se
  // descuenta de la ganancia neta (porcentaje de venta o comisión fija).
  const [companyCompensation, setCompanyCompensation] = useState<{ mode: 'fixed_product' | 'sales_percent'; percentRate: number }>({ mode: 'fixed_product', percentRate: 0 });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tenant = await getActiveTenant();
        if (!tenant?.companyId) return;
        const settings = await loadCompensationSettings(tenant.companyId);
        if (!cancelled) setCompanyCompensation({
          mode: settings.mode,
          percentRate: Math.max(0, Math.min(100, Number(settings.percentRate) || 0))
        });
      } catch (error) {
        console.warn('[Inventory] No se pudo cargar la compensación global; la ganancia neta usará 0 de salario:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Un empleado solo opera sobre sus almacenes autorizados; el administrador ve todos.
  const authorizedBranchIds = useMemo(
    () => currentUser?.role === 'admin' ? [] : getAuthorizedWarehouseIds(currentUser),
    [currentUser]
  );
  const isBranchRestricted = currentUser?.role !== 'admin' && authorizedBranchIds.length > 0;
  const allowedBranches = useMemo(
    () => isBranchRestricted ? (branches || []).filter(branch => authorizedBranchIds.includes(branch.id)) : (branches || []),
    [branches, isBranchRestricted, authorizedBranchIds]
  );

  const hasFixedProductEmployees = (users || []).some(user => user.isActive !== false && (user.compensationType || 'fixed_product') === 'fixed_product');
  const categoryById = useMemo(
    () => new Map((categories || []).map(category => [category.id, category])),
    [categories]
  );

  const getBranchDisplayName = (b: { id: string; name: string }) => {
    const assignedUser = (users || []).find(u => getWarehouseId(u) === b.id);
    return assignedUser ? `${b.name} (${assignedUser.name})` : b.name;
  };

  // Preferred card order is local to this set of warehouses and works offline.
  const warehouseOrderStorageKey = useMemo(
    () => `palmyra-stock-manager-warehouse-order-v1:${(branches || []).map(branch => branch.id).filter(Boolean).sort().join('|')}`,
    [branches]
  );
  const [warehouseCardOrder, setWarehouseCardOrder] = useState<string[]>([]);
  const [warehouseOrderLoadedKey, setWarehouseOrderLoadedKey] = useState('');
  useEffect(() => {
    const knownIds = new Set((branches || []).map(branch => branch.id));
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(warehouseOrderStorageKey) : null;
      const saved: unknown = raw ? JSON.parse(raw) : [];
      setWarehouseCardOrder(Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string' && knownIds.has(id))
        : []);
    } catch {
      setWarehouseCardOrder([]);
    }
    setWarehouseOrderLoadedKey(warehouseOrderStorageKey);
  }, [warehouseOrderStorageKey, branches]);
  useEffect(() => {
    if (warehouseOrderLoadedKey !== warehouseOrderStorageKey) return;
    try {
      const validIds = new Set((branches || []).map(branch => branch.id));
      window.localStorage.setItem(warehouseOrderStorageKey, JSON.stringify(warehouseCardOrder.filter(id => validIds.has(id))));
    } catch {
      // Card arrangement is a local display preference; inventory editing must still work if storage is unavailable.
    }
  }, [branches, warehouseCardOrder, warehouseOrderLoadedKey, warehouseOrderStorageKey]);
  const orderedBranches = useMemo(() => {
    const branchIds = new Set(allowedBranches.map(branch => branch.id));
    const orderedIds = [
      ...warehouseCardOrder.filter(id => branchIds.has(id)),
      ...allowedBranches.map(branch => branch.id).filter(id => !warehouseCardOrder.includes(id)),
    ];
    const byId = new Map(allowedBranches.map(branch => [branch.id, branch]));
    return orderedIds.map(id => byId.get(id)).filter(Boolean) as typeof branches;
  }, [allowedBranches, warehouseCardOrder]);
  const moveWarehouseCard = (branchId: string, delta: number) => {
    const order = orderedBranches.map(branch => branch.id);
    const index = order.indexOf(branchId);
    const targetIndex = Math.max(0, Math.min(order.length - 1, index + delta));
    if (index < 0 || index === targetIndex) return;
    [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
    setWarehouseCardOrder(order);
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  // Debounce search query to improve performance on low-end tablets
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  
  useBarcodeScanner((barcode) => {
    setSearchQuery(barcode);
  });
  const [selectedBranch, setSelectedBranch] = useState("all");

  React.useEffect(() => {
    if (!isBranchRestricted) return;
    const allowedIds = new Set(allowedBranches.map(branch => branch.id));
    if (selectedBranch === 'all' || !allowedIds.has(selectedBranch)) {
      setSelectedBranch(allowedBranches[0]?.id || 'all');
    }
  }, [isBranchRestricted, allowedBranches, selectedBranch]);

  const [pendingDelete, setPendingDelete] = useState<{ kind: 'product' | 'category'; id: string; name: string } | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [managingStockProduct, setManagingStockProduct] = useState<Product | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  // En móvil/tablet la lista ancha no cabe: se abre en tarjetas para no
  // obligar a un desplazamiento horizontal. En escritorio sigue la tabla.
  const [viewMode, setViewMode] = useState<'table' | 'grid'>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches ? 'grid' : 'table'
  );
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low' | 'out'>('all');
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'products' | 'labels' | 'abc' | 'restock' | 'bulk' | 'excel'>('products');

  // La selección masiva solo es válida para la vista actual: si cambian los
  // filtros, aplicar acciones a filas ocultas sería una acción invisible.
  React.useEffect(() => {
    setSelectedItems([]);
  }, [debouncedSearchQuery, selectedBranch, selectedCategory, stockFilter, activeTab]);
  const [planCode, setPlanCode] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => { if (active) setPlanCode(ctx?.subscription?.planCode || null); }).catch(() => { if (active) setPlanCode(null); });
    return () => { active = false; };
  }, []);
  const [showBatchPriceModal, setShowBatchPriceModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categoryViewport, setCategoryViewport] = useState({ height: 0, top: 0 });
  const [stockViewport, setStockViewport] = useState({ height: 0, top: 0 });


  useEffect(() => {
    if (!showAddModal || typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    const modal = document.querySelector<HTMLElement>('.inventory-product-modal');

    const syncVisualViewport = () => {
      document.documentElement.style.setProperty(
        '--palmyra-vv-height',
        `${viewport?.height || window.innerHeight}px`
      );
      document.documentElement.style.setProperty(
        '--palmyra-vv-top',
        `${viewport?.offsetTop || 0}px`
      );
    };

    // Desplaza solo el cuerpo del formulario (no toda la página) cuando el
    // teclado reduce el área visible, para que el campo enfocado siga accesible.
    const keepFocusedFieldVisible = () => {
      const body = modal?.querySelector<HTMLElement>('.team-employee-modal-body');
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !body || !body.contains(active)) return;
      if (!active.matches('input, textarea, select')) return;

      const fieldRect = active.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const visibleTop = Math.max(bodyRect.top, viewport?.offsetTop || 0) + 10;
      const visibleBottom = Math.min(
        bodyRect.bottom,
        (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight)
      ) - 10;

      if (fieldRect.bottom > visibleBottom) {
        body.scrollTop += Math.ceil(fieldRect.bottom - visibleBottom + 8);
      } else if (fieldRect.top < visibleTop) {
        body.scrollTop -= Math.ceil(visibleTop - fieldRect.top + 8);
      }
    };

    const syncAndRevealFocus = () => {
      syncVisualViewport();
      requestAnimationFrame(keepFocusedFieldVisible);
    };
    const handleViewportScroll = () => syncVisualViewport();
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('input, textarea, select')) {
        requestAnimationFrame(keepFocusedFieldVisible);
      }
    };

    syncVisualViewport();
    modal?.addEventListener('focusin', handleFocusIn);
    viewport?.addEventListener('resize', syncAndRevealFocus);
    viewport?.addEventListener('scroll', handleViewportScroll);
    window.addEventListener('resize', syncAndRevealFocus);

    return () => {
      modal?.removeEventListener('focusin', handleFocusIn);
      viewport?.removeEventListener('resize', syncAndRevealFocus);
      viewport?.removeEventListener('scroll', handleViewportScroll);
      window.removeEventListener('resize', syncAndRevealFocus);
      document.documentElement.style.removeProperty('--palmyra-vv-height');
      document.documentElement.style.removeProperty('--palmyra-vv-top');
    };
  }, [showAddModal]);

  // Mantiene el modal de stock dentro del área realmente visible en móviles,
  // incluso cuando el teclado virtual reduce el visual viewport.
  useEffect(() => {
    if (!managingStockProduct || typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    const pendingTimers: number[] = [];
    let pendingFrame: number | undefined;

    const syncStockViewport = () => {
      setStockViewport({
        height: viewport?.height || window.innerHeight,
        top: viewport?.offsetTop || 0,
      });
    };

    const revealFocusedStockField = () => {
      const modal = document.querySelector<HTMLElement>('.stock-manage-modal');
      const body = modal?.querySelector<HTMLElement>('.stock-manage-scroll');
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !body || !body.contains(active)) return;
      if (!active.matches('input, textarea, select')) return;

      const viewportTop = viewport?.offsetTop || 0;
      const viewportHeight = viewport?.height || window.innerHeight;
      const fieldRect = active.getBoundingClientRect();
      const visibleTop = viewportTop + 12;
      const visibleBottom = viewportTop + viewportHeight - 12;

      if (fieldRect.bottom > visibleBottom) {
        body.scrollTop += Math.ceil(fieldRect.bottom - visibleBottom + 18);
      } else if (fieldRect.top < visibleTop) {
        body.scrollTop -= Math.ceil(visibleTop - fieldRect.top + 18);
      }
    };

    const syncAndRevealFocusedField = () => {
      syncStockViewport();
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        revealFocusedStockField();
        // Android/Chrome can report the keyboard's final height a moment later.
        pendingTimers.push(window.setTimeout(revealFocusedStockField, 120));
        pendingTimers.push(window.setTimeout(revealFocusedStockField, 280));
      });
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('input, textarea, select')) {
        syncAndRevealFocusedField();
      }
    };
    const handleViewportScroll = () => {
      syncStockViewport();
      requestAnimationFrame(revealFocusedStockField);
    };

    const modal = document.querySelector<HTMLElement>('.stock-manage-modal');
    syncStockViewport();
    modal?.addEventListener('focusin', handleFocusIn);
    viewport?.addEventListener('resize', syncAndRevealFocusedField);
    viewport?.addEventListener('scroll', handleViewportScroll);
    window.addEventListener('resize', syncAndRevealFocusedField);

    return () => {
      modal?.removeEventListener('focusin', handleFocusIn);
      viewport?.removeEventListener('resize', syncAndRevealFocusedField);
      viewport?.removeEventListener('scroll', handleViewportScroll);
      window.removeEventListener('resize', syncAndRevealFocusedField);
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      pendingTimers.forEach(timer => window.clearTimeout(timer));
    };
  }, [managingStockProduct]);

  useEffect(() => {
    if (!showCategoryModal || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      setCategoryViewport({
        height: viewport?.height || window.innerHeight,
        top: viewport?.offsetTop || 0,
      });
    };
    syncViewport();
    viewport?.addEventListener('resize', syncViewport);
    viewport?.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    return () => {
      viewport?.removeEventListener('resize', syncViewport);
      viewport?.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
    };
  }, [showCategoryModal]);
  const [activeFormTab, setActiveFormTab] = useState<'general' | 'variants' | 'extra'>('general');
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryFormData, setCategoryFormData] = useState({ name: "", department: "" });
  const [batchPriceAdjust, setBatchPriceAdjust] = useState({ type: 'percentage' as 'percentage' | 'fixed', value: 0, direction: 'increase' as 'increase' | 'decrease' });
  const [bulkChanges, setBulkChanges] = useState<Record<string, { name?: string, costPrice?: number, price?: number, quantity?: number, commissionValue?: number }>>({});
  const [isSavingBulk, setIsSavingBulk] = useState(false);
  const [bulkPriceSort, setBulkPriceSort] = useState<'none' | 'asc' | 'desc'>('none');
  const bulkDraftStorageKey = useMemo(
    () => `palmyra-inventory-bulk-draft-v1:${(branches || []).map(branch => branch.id).filter(Boolean).sort().join('|') || 'default'}`,
    [branches]
  );
  const [bulkDraftLoadedKey, setBulkDraftLoadedKey] = useState('');
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(bulkDraftStorageKey);
      const saved = raw ? JSON.parse(raw) : {};
      setBulkChanges(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {});
    } catch {
      setBulkChanges({});
    }
    setBulkDraftLoadedKey(bulkDraftStorageKey);
  }, [bulkDraftStorageKey]);
  useEffect(() => {
    if (bulkDraftLoadedKey !== bulkDraftStorageKey) return;
    try {
      if (Object.keys(bulkChanges).length) window.localStorage.setItem(bulkDraftStorageKey, JSON.stringify(bulkChanges));
      else window.localStorage.removeItem(bulkDraftStorageKey);
    } catch {
      // The in-memory draft remains available if browser storage is blocked or full.
    }
  }, [bulkChanges, bulkDraftLoadedKey, bulkDraftStorageKey]);
  const bulkVisibleProducts = useMemo(() => {
    const query = debouncedSearchQuery.trim().toLowerCase();
    const filtered = (products || []).filter(product => !query ||
      product.name.toLowerCase().includes(query) ||
      product.sku?.toLowerCase().includes(query) ||
      product.barcode?.toLowerCase().includes(query)
    );
    if (bulkPriceSort === 'none') return filtered;
    return [...filtered].sort((a, b) => {
      const delta = Number(a.price || 0) - Number(b.price || 0);
      return bulkPriceSort === 'asc' ? delta : -delta;
    });
  }, [products, debouncedSearchQuery, bulkPriceSort]);
  const [bulkBranchId, setBulkBranchId] = useState<string>(branches[0]?.id || "");

  // Auto-select first branch when they load
  React.useEffect(() => {
    if (!bulkBranchId && branches.length > 0) {
      setBulkBranchId(branches[0].id);
    }
  }, [branches, bulkBranchId]);

  const handleBulkChange = (id: string, field: 'name' | 'costPrice' | 'price' | 'quantity' | 'commissionValue', value: string | number) => {
    const [prodId] = id.split(':::');
    const normalizedValue = field === 'name' ? String(value) : Number(value);
    const applyField = (key: string, prev: typeof bulkChanges) => ({
      ...(prev[key] || {}),
      [field]: normalizedValue
    }) as { name?: string; costPrice?: number; price?: number; quantity?: number; commissionValue?: number };

    setBulkChanges(prev => {
      const next = { ...prev };
      if (field === 'quantity') {
        // Quantity is branch-specific; all other fields are product-global.
        next[id] = applyField(id, prev);
      } else {
        const productRows = Object.keys(next).filter(key => key.startsWith(`${prodId}:::`));
        if (productRows.length === 0) next[id] = applyField(id, prev);
        else productRows.forEach(key => { next[key] = applyField(key, prev); });
      }
      return next;
    });
  };

  const saveBulkChanges = async () => {
    if (isSavingBulk || Object.keys(bulkChanges).length === 0) return;
    setIsSavingBulk(true);
    try {
      const productUpdates: Record<string, { name?: string, costPrice?: number, price?: number, commissionValue?: number }> = {};
      for (const [id, changes] of Object.entries(bulkChanges)) {
        const [prodId] = id.split(':::');
        if (changes.name !== undefined || changes.price !== undefined || changes.costPrice !== undefined || changes.commissionValue !== undefined) {
          productUpdates[prodId] = {
            ...productUpdates[prodId],
            ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
            ...(changes.price !== undefined ? { price: changes.price } : {}),
            ...(changes.costPrice !== undefined ? { costPrice: changes.costPrice } : {}),
            ...(changes.commissionValue !== undefined ? { commissionValue: changes.commissionValue } : {})
          };
        }
      }

      // Offline-first: la edición se aplica localmente y, si la red falla, queda
      // encolada. Un error permanente conserva el borrador completo.
      let queued = 0;
      for (const [prodId, updates] of Object.entries(productUpdates)) {
        const current = useStore.getState().products.find(product => product.id === prodId);
        if (!current) throw new Error(`No se encontró el producto ${prodId}; el borrador se conserva.`);
        const updated = { ...current, ...updates };
        if (updates.price !== undefined || updates.costPrice !== undefined) {
          updated.margin = Math.max(0, Number(updated.price || 0) - Number(updated.costPrice || 0));
        }
        const confirmed = await pushProductToSupabase(updated);
        if (!confirmed) queued += 1;
        useStore.setState(state => ({ products: state.products.map(product => product.id === prodId ? updated : product) }));
      }

      setBulkChanges({});
      if (queued > 0) {
        addNotification(`${Object.keys(productUpdates).length - queued} productos confirmados; ${queued} quedaron pendientes de sincronizar.`, 'info');
      } else {
        addNotification(`Cambios masivos guardados y confirmados: ${Object.keys(productUpdates).length} productos.`, 'success');
      }
    } catch (err) {
      console.error('[PALMYRA] bulk inventory save failed; draft preserved', err);
      addNotification('No se confirmaron todos los cambios. El borrador se conservó; corrige el error y vuelve a Guardar.', 'error');
    } finally {
      setIsSavingBulk(false);
    }
  };

  const handleBatchUpdateStatus = (status: 'active' | 'discontinued' | 'draft') => {
    batchUpdateProducts(selectedItems, { status });
    setSelectedItems([]);
  };

  const handleBatchPriceApply = () => {
    const factor = batchPriceAdjust.direction === 'increase' ? 1 : -1;
    
    selectedItems.forEach(id => {
      const product = products.find(p => p.id === id);
      if (product) {
        let newPrice = product.price;
        if (batchPriceAdjust.type === 'percentage') {
          newPrice = product.price * (1 + (batchPriceAdjust.value / 100) * factor);
        } else {
          newPrice = product.price + (batchPriceAdjust.value * factor);
        }
        updateProduct(id, { price: Math.max(0, newPrice), margin: Math.max(0, newPrice - product.costPrice) });
      }
    });
    
    setShowBatchPriceModal(false);
    setSelectedItems([]);
    addNotification(`Se han actualizado ${selectedItems.length} precios.`, 'success');
  };

  // Form State
  const [formData, setFormData] = useState<Partial<Product>>({
    name: "",
    sku: "",
    barcode: "",
    costPrice: 0,
    price: 0,
    margin: 0,
    categoryId: "",
    color: "bg-slate-100 text-slate-700",
    commissionValue: 0,
    availableSizes: [],
    availableColors: []
  });

  const [newSize, setNewSize] = useState("");
  const [newColor, setNewColor] = useState("");
  const [stockDrafts, setStockDrafts] = useState<Record<string, { quantity: string; minQuantity: string }>>({});
  const stockDraftKey = (productId: string, branchId: string, variant?: string) => `${productId}::${branchId}::${variant || ''}`;
  const readStockDraft = (productId: string, branchId: string, variant: string | undefined, quantity: number, minQuantity: number) => {
    const key = stockDraftKey(productId, branchId, variant);
    const draft = stockDrafts[key];
    return draft ?? { quantity: quantity ? String(quantity) : '', minQuantity: minQuantity ? String(minQuantity) : '' };
  };

  const openStockManager = (product: Product) => {
    const hasVariants =
      (product.availableSizes || []).length > 0 ||
      (product.availableColors || []).length > 0;
    const variants = Array.from(new Set([
      ...(hasVariants ? [] : [undefined]),
      ...(product.availableSizes || []),
      ...(product.availableColors || [])
    ]));
    const next: Record<string, { quantity: string; minQuantity: string }> = {};
    branches.forEach(branch => {
      variants.forEach(variant => {
        const level = inventory.find(i =>
          i.productId === product.id &&
          i.branchId === branch.id &&
          (i.variantLabel || '') === (variant || '')
        );
        next[stockDraftKey(product.id, branch.id, variant)] = {
          quantity: level ? String(level.quantity ?? '') : '',
          minQuantity: level ? String(level.minQuantity ?? '') : ''
        };
      });
    });
    setStockDrafts(prev => {
      const cleaned = { ...prev };
      Object.keys(cleaned).forEach(key => {
        if (key.startsWith(product.id + '::')) delete cleaned[key];
      });
      return { ...cleaned, ...next };
    });
    setManagingStockProduct(product);
  };
  const updateStockDraft = (productId: string, branchId: string, variant: string | undefined, field: 'quantity' | 'minQuantity', value: string) => {
    const key = stockDraftKey(productId, branchId, variant);
    setStockDrafts(prev => ({ ...prev, [key]: { ...(prev[key] || { quantity: '', minQuantity: '' }), [field]: value } }));
  };
  const commitStockDraft = (productId: string, branchId: string, variant: string | undefined, fallbackQuantity: number, fallbackMin: number) => {
    const draft = stockDrafts[stockDraftKey(productId, branchId, variant)];
    if (!draft) return;
    const quantity = draft.quantity === '' ? 0 : Math.max(0, parseInt(draft.quantity, 10) || 0);
    const minQuantity = draft.minQuantity === '' ? 0 : Math.max(0, parseInt(draft.minQuantity, 10) || 0);
    if (quantity !== fallbackQuantity || minQuantity !== fallbackMin) setInventoryQuantity(productId, branchId, quantity, variant, minQuantity);
  };

  const commitAllStockDrafts = () => {
    const productId = managingStockProduct?.id;
    if (!productId) return;
    Object.entries(stockDrafts).forEach(([key, draft]) => {
      const [draftProductId, branchId, ...variantParts] = key.split('::');
      if (draftProductId !== productId || !branchId) return;
      const variant = variantParts.join('::') || undefined;
      const current = inventory.find(i =>
        i.productId === productId && i.branchId === branchId &&
        (i.variantLabel || '') === (variant || '')
      );
      const quantity = draft.quantity === '' ? 0 : Math.max(0, parseInt(draft.quantity, 10) || 0);
      const minQuantity = draft.minQuantity === '' ? 0 : Math.max(0, parseInt(draft.minQuantity, 10) || 0);
      if (quantity !== Number(current?.quantity || 0) || minQuantity !== Number(current?.minQuantity || 0)) {
        setInventoryQuantity(productId, branchId, quantity, variant, minQuantity);
      }
    });
    setStockDrafts(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(key => { if (key.startsWith(productId + '::')) delete next[key]; });
      return next;
    });
  };

  const [showKitPicker, setShowKitPicker] = useState(false);
  const [kitQuery, setKitQuery] = useState("");

  const handleCostPriceChange = (cost: number, price: number) => {
    const margin = price - cost;
    setFormData(prev => ({ ...prev, costPrice: cost, price, margin }));
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct && activeFormTab !== 'extra') {
      if (activeFormTab === 'general' && (!String(formData.name || '').trim() || !String(formData.categoryId || '').trim() || !String(formData.sku || '').trim())) {
        addNotification("Completa nombre, categoría y SKU antes de continuar.", 'error');
        return;
      }
      setActiveFormTab(activeFormTab === 'general' ? 'variants' : 'extra');
      return;
    }
    // El stock se indexa por una sola etiqueta de variante. Tallas y colores a
    // la vez generarían existencias "fantasma" que el POS no puede descontar.
    if ((formData.availableSizes || []).length > 0 && (formData.availableColors || []).length > 0) {
      addNotification("Usa un solo tipo de variante: tallas o colores, no ambos. Así el stock y el POS coinciden exactamente.", 'error');
      return;
    }
    if (editingProduct) {
      updateProduct(editingProduct.id, {
        ...formData,
        commissionValue: hasFixedProductEmployees ? Number(formData.commissionValue || 0) : 0,
      });
      addNotification("Producto actualizado correctamente.", 'success');
    } else {
      const newProduct: Product = {
        ...formData as Product,
        id: generateId('PRD'),
        commissionValue: hasFixedProductEmployees ? Number(formData.commissionValue || 0) : 0,
      };
      const created = addProduct(newProduct);
      if (created === false) return;
    }
    setShowAddModal(false);
    setEditingProduct(null);
    setActiveFormTab('general');
    setFormData({ 
      name: "", sku: "", barcode: "", costPrice: 0, price: 0, margin: 0, categoryId: "", 
      color: "bg-slate-100 text-slate-700", commissionValue: 0,
      availableSizes: [], availableColors: []
    });
  };

  const exportToCSV = () => {
    // Se exporta el inventario filtrado completo, no solo la página visible.
    const csvContent = buildInventoryCsv(inventoryData.full, categories);
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `PALMYRA_Inventario_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportToExcel = async () => {
    const rows = inventoryData.full.map((item: any) => {
      const levels = Array.isArray(item.levels) ? item.levels : [];
      const minFromLevels = levels.reduce((min: number, level: any) => Math.max(min, Number(level.minQuantity) || 0), 0);
      return {
        id: item.id,
        name: item.name || '',
        sku: item.sku || '',
        barcode: item.barcode || '',
        categoryId: item.categoryId,
        categoryName: categoryById.get(item.categoryId)?.name || 'Sin categoría',
        unit: item.unit || 'uds',
        price: Number(item.price) || 0,
        costPrice: Number(item.costPrice) || 0,
        totalStock: Number(item.totalStock ?? item.quantity ?? 0),
        minQuantity: minFromLevels || Number(item.minStockAlert) || 0,
        lowStockThreshold: getLowStockThreshold(item, minFromLevels),
        status: item.status,
      };
    });
    try {
      const { exportInventoryToExcel } = await import('../utils/excelExport');
      await exportInventoryToExcel(rows, {
        businessName: receiptConfig?.businessName || 'PALMYRA',
        currencyCode: baseCurrency.code,
      });
    } catch (error) {
      console.error('[Inventory] No se pudo exportar el inventario a Excel:', error);
      addNotification('No se pudo generar el Excel de inventario. Intenta nuevamente.', 'error');
    }
  };

  const canExcel = canUsePlanFeature(planCode, 'excel_exports');
  const canLabels = canUsePlanFeature(planCode, 'labels');
  const canABC = canUsePlanFeature(planCode, 'abc_analysis');

  const handleCategorySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const { addCategory, updateCategory } = useStore.getState();
    if (editingCategory) {
      updateCategory(editingCategory.id, categoryFormData);
    } else {
      addCategory({
        id: generateId('CAT'),
        ...categoryFormData
      } as Category);
    }
    setEditingCategory(null);
    setCategoryFormData({ name: "", department: "" });
  };

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const image = await resizeProductImage(file);
      setFormData(prev => ({ ...prev, image }));
    } catch (error) {
      console.error('No se pudo procesar la imagen del producto:', error);
    }
  };

  const [displayLimit, setDisplayLimit] = useState(200);

  // Memoizado: sin esto la vista completa (filtro + cálculo de stock por
  // producto) se recalculaba en cada render, incluido cada carácter escrito en
  // el formulario de alta o en cualquier modal abierto.
  const inventoryData = useMemo(
    () => buildInventoryViewData(
      products || [],
      inventory || [],
      debouncedSearchQuery,
      selectedBranch,
      selectedCategory,
      stockFilter,
      displayLimit,
      companyCompensation
    ),
    [products, inventory, debouncedSearchQuery, selectedBranch, selectedCategory, stockFilter, displayLimit, companyCompensation]
  );

  const inventoryView = inventoryData.paginated;
  const hasActiveFilters = Boolean(debouncedSearchQuery.trim()) || selectedCategory !== 'all' || stockFilter !== 'all' || selectedBranch !== 'all';

  const formatMoney = (amount: number, currency = baseCurrency, withCode = true) => {
    const converted = currency.isBase ? amount : amount / (currency.rateToBase || 1);
    const formatted = converted.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (withCode) {
      return `${currency.code} ${currency.symbol}${formatted}`;
    }
    return `${currency.symbol} ${formatted}`;
  };

  // La ganancia puede ser negativa: el signo siempre se muestra explícito para
  // no depender únicamente del color.
  const formatSignedMoney = (amount: number, currency = baseCurrency, withCode = false) => {
    const safe = Number.isFinite(amount) ? amount : 0;
    const sign = safe < 0 ? '-' : safe > 0 ? '+' : '';
    return `${sign}${formatMoney(Math.abs(safe), currency, withCode)}`;
  };

  const formatMarginPct = (pct: number) => {
    const safe = Number.isFinite(pct) ? pct : 0;
    return `${safe > 0 ? '+' : ''}${safe.toFixed(1)}%`;
  };

  const profitToneClass = (value: number) => {
    const safe = Number.isFinite(value) ? value : 0;
    if (safe > 0) return 'text-emerald-600 dark:text-emerald-400';
    if (safe < 0) return 'text-rose-600 dark:text-rose-400';
    return 'text-muted';
  };

  // Equivalentes USD/EUR de las cifras del inventario (CUP). Mandan las tasas
  // activas del negocio: las manuales de Monedas y tasas o las que escribe la
  // sincronización automática. En segundo plano se consulta el servicio de
  // tasas con enfriamiento solo para rellenar divisas sin tasa local; si no
  // responde, la pantalla sigue en CUP, sin avisos ni bloqueos.
  const [serviceCurrencyRates, setServiceCurrencyRates] = useState<CurrencyRate[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadServiceCurrencyRates().then((rates) => {
      if (!cancelled && rates.length) setServiceCurrencyRates(rates);
    });
    return () => { cancelled = true; };
  }, []);

  const equivalentRates = useMemo(
    () => mergeCurrencyRates(ratesFromCurrencies(currencies, baseCurrency.code), serviceCurrencyRates),
    [currencies, baseCurrency.code, serviceCurrencyRates]
  );
  const equivalentsFor = (amount: number) => currencyEquivalents(amount, equivalentRates);

  // Los indicadores reflejan la sucursal activa, no la búsqueda ni los filtros
  // de la tabla: buscar un producto no debe alterar las cifras globales.
  const stats = useMemo(() => {
    const levelsByProduct = new Map<string, Array<{ quantity: number }>>();
    for (const level of inventory || []) {
      if (selectedBranch !== 'all' && level.branchId !== selectedBranch) continue;
      const existing = levelsByProduct.get(level.productId);
      if (existing) existing.push(level);
      else levelsByProduct.set(level.productId, [level]);
    }

    let totalProducts = 0;
    let totalStock = 0;
    let lowStockCount = 0;
    const profitRows: Array<{ price: number; costPrice: number; commissionValue: number; totalStock: number }> = [];

    // El contador usa la misma regla que la lista: total del producto, no filas.
    for (const product of products || []) {
      const levels = levelsByProduct.get(product.id) || [];
      const productStock = Math.max(0, sumAvailableStock(levels));
      totalProducts += 1;
      totalStock += productStock;
      if (isLowStockProduct(levels, product)) lowStockCount += 1;
      profitRows.push({
        price: Number(product.price || 0),
        costPrice: Number(product.costPrice || 0),
        commissionValue: Number(product.commissionValue || 0),
        totalStock: productStock
      });
    }

    const profit = summarizeInventoryProfit(profitRows, companyCompensation);

    return { totalProducts, totalStock, lowStockCount, ...profit };
  }, [inventory, products, selectedBranch, companyCompensation]);

  const kpiEquivalents = useMemo(() => ({
    cost: currencyEquivalents(stats.valueCost, equivalentRates),
    sale: currencyEquivalents(stats.valueSale, equivalentRates),
    profit: currencyEquivalents(stats.netProfit, equivalentRates)
  }), [stats, equivalentRates]);

  // Texto compacto de las equivalencias (una sola línea) calculado una vez.
  const kpiEquivalentText = useMemo(() => ({
    cost: formatCurrencyEquivalents(kpiEquivalents.cost, { compact: true }),
    sale: formatCurrencyEquivalents(kpiEquivalents.sale, { compact: true }),
    profit: formatCurrencyEquivalents(kpiEquivalents.profit, { compact: true, signed: true })
  }), [kpiEquivalents]);

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col min-h-0">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-2 px-1 shrink-0">
        <div>
          <h2 data-palmi-content="inventory" className="text-lg sm:text-xl font-black text-primary tracking-tight flex items-center gap-2 uppercase">
            Inventario
          </h2>
          <p className="text-[9px] sm:text-[10px] font-black text-muted uppercase tracking-widest">Stock Control</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:flex-nowrap py-1">
          <button 
            onClick={() => setActiveTab('products')}
            className="shrink-0 min-h-11 sm:min-h-0 bg-emerald-600 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-emerald-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            <PackageCheck className="w-3.5 h-3.5" /> Stock
          </button>
          <button 
            onClick={() => {
              setEditingProduct(null);
              setNewSize("");
              setNewColor("");
              setFormData({ 
                name: "", sku: "", barcode: "", costPrice: 0, price: 0, margin: 0, categoryId: "", 
                color: "bg-slate-100 text-slate-700", commissionType: 'fixed', commissionValue: 0,
                availableSizes: [], availableColors: []
              });
              setActiveFormTab('general');
              setShowAddModal(true);
            }}
            className="shrink-0 min-h-11 sm:min-h-0 bg-indigo-600 text-white px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            Agregar producto
          </button>
          <button 
            onClick={() => canExcel ? exportToExcel() : setActiveTab('excel')}
            className="shrink-0 min-h-11 sm:min-h-0 flex items-center gap-1.5 px-2.5 py-1.5 bg-secondary border border-base text-muted rounded-xl text-[9px] font-black uppercase tracking-wider hover:bg-subtle transition-all shadow-sm active:scale-95 whitespace-nowrap"
          >
            <Download className="w-3 h-3" />
            <span>{canExcel ? 'Excel' : 'Excel · Ciudadela'}</span>
          </button>
          <button 
            onClick={() => setActiveTab('labels')}
            className="shrink-0 min-h-11 sm:min-h-0 bg-slate-900 dark:bg-slate-800 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-slate-800 dark:hover:bg-slate-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            {canLabels ? 'Etiquetas' : 'Etiquetas · Ciudadela'}
          </button>
          <button 
            onClick={() => setActiveTab('abc')}
            className="shrink-0 min-h-11 sm:min-h-0 bg-blue-600 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-blue-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            {canABC ? 'Análisis ABC' : 'ABC · Ciudadela'}
          </button>

        </div>
      </header>

      {/* Summary Cards Lineal - Responsive Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-1.5 sm:gap-2 px-1 shrink-0">
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Tipos</span>
          <div className="text-[11px] font-black text-primary mt-0.5">{stats.totalProducts.toLocaleString()}</div>
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Unidades</span>
          <div className="text-[11px] font-black text-primary mt-0.5">{stats.totalStock.toLocaleString()}</div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-rose-500 tracking-wider">Bajo Stock</span>
          <div className="text-[11px] font-black text-rose-600 dark:text-rose-400 mt-0.5">{stats.lowStockCount} alertas</div>
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Valor costo · CUP</span>
          <div className="text-[10px] font-black text-primary mt-0.5 truncate tabular-nums" title={formatMoney(stats.valueCost)}>{formatMoney(stats.valueCost, baseCurrency, false)}</div>
          {kpiEquivalentText.cost !== '—' && (
            <div className="text-[7px] font-bold text-muted mt-0.5 leading-tight tabular-nums" title={`${formatCurrencyEquivalents(kpiEquivalents.cost)} · tasas activas`}>{kpiEquivalentText.cost}</div>
          )}
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Valor venta · CUP</span>
          <div className="text-[10px] font-black text-primary mt-0.5 truncate tabular-nums" title={formatMoney(stats.valueSale)}>{formatMoney(stats.valueSale, baseCurrency, false)}</div>
          {kpiEquivalentText.sale !== '—' && (
            <div className="text-[7px] font-bold text-muted mt-0.5 leading-tight tabular-nums" title={`${formatCurrencyEquivalents(kpiEquivalents.sale)} · tasas activas`}>{kpiEquivalentText.sale}</div>
          )}
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Ganancia neta · CUP</span>
          <div className={cn("text-[10px] font-black mt-0.5 truncate tabular-nums", profitToneClass(stats.netProfit))} title={formatSignedMoney(stats.netProfit)}>{formatSignedMoney(stats.netProfit, baseCurrency, false)}</div>
          {kpiEquivalentText.profit !== '—' && (
            <div className="text-[7px] font-bold text-muted mt-0.5 leading-tight tabular-nums" title={`${formatCurrencyEquivalents(kpiEquivalents.profit, { signed: true })} · tasas activas`}>{kpiEquivalentText.profit}</div>
          )}
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between min-w-0">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">% margen</span>
          <div className={cn("text-[10px] font-black mt-0.5 truncate tabular-nums", profitToneClass(stats.marginPct))} title="Margen sobre el precio de venta">{formatMarginPct(stats.marginPct)}</div>
        </div>
      </div>

      {/* Advanced Unified Toolbar - Compact & Responsive for Mobile/Tablet */}
      <div className="bg-secondary p-2 sm:p-2.5 rounded-2xl border border-base shadow-sm flex flex-col md:flex-row gap-2 items-stretch md:items-center justify-between shrink-0">
        <div className="flex flex-col sm:flex-row gap-1.5 sm:gap-2 items-stretch sm:items-center flex-1 min-w-0">
          {/* Search bar */}
          <div className="relative flex-1 min-w-[140px] group">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted group-focus-within:text-indigo-500 transition-colors" />
            <input 
              type="text" 
              aria-label="Buscar productos por nombre, SKU o código"
              placeholder="Buscar por nombre, SKU, código..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 h-11 sm:h-8 bg-subtle border border-base text-primary rounded-xl text-[12px] sm:text-[11px] font-semibold focus:bg-secondary focus:ring-1 focus:ring-indigo-500 outline-none transition-all placeholder:text-muted/60"
            />
          </div>
          
          {/* Filtros: sucursal y stock. Categorías se gestionan de forma independiente. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 w-full sm:w-auto">
            {/* Sucursal */}
            <div className="relative group w-full sm:min-w-[140px] sm:max-w-[180px]">
              <Building2 className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
              <select 
                value={selectedBranch}
                onChange={(e) => setSelectedBranch(e.target.value)}
                aria-label="Filtrar por sucursal"
                className="w-full pl-6 pr-7 h-11 sm:h-8 bg-subtle border border-base text-primary rounded-lg text-[11px] sm:text-[9px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
                title="Filtrar por sucursal"
              >
                {!isBranchRestricted && <option value="all">Sucursal</option>}
                {allowedBranches.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
            </div>

            {/* Categoría */}
            <div className="relative group w-full sm:min-w-[140px] sm:max-w-[180px]">
              <Tag className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
              <select 
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                aria-label="Filtrar por categoría"
                className="w-full pl-6 pr-5 h-11 sm:h-8 bg-subtle border border-base text-primary rounded-lg text-[11px] sm:text-[9px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
                title="Filtrar por categoría"
              >
                <option value="all">Categoría</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
            </div>

            {/* Stock */}
            <div className="relative group w-full sm:min-w-[110px] sm:max-w-[150px]">
              <PackageCheck className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-indigo-500 pointer-events-none" aria-hidden="true" />
              <select 
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value as any)}
                aria-label="Filtrar por stock"
                className="w-full px-6 pr-7 h-11 sm:h-8 bg-subtle border border-base text-primary rounded-lg text-[11px] sm:text-[9px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
                title="Filtrar por stock"
              >
                <option value="all">Stock</option>
                <option value="in_stock">Con stock</option>
                <option value="low">Bajos</option>
                <option value="out">Ceros</option>
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
            </div>

          </div>
        </div>

        <div className="flex items-center gap-2 self-end md:self-auto justify-end border-t md:border-t-0 pt-1.5 md:pt-0">
          <div className="bg-subtle p-0.5 rounded-lg flex gap-0.5 border border-base">
            <button 
              onClick={() => setViewMode('table')}
              title="Vista Lista"
              aria-label="Vista lista"
              aria-pressed={viewMode === 'table'}
              className={cn(
                "min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-1.5 rounded-md transition-all",
                viewMode === 'table' ? "bg-primary text-indigo-600 shadow-xs ring-1 ring-black/5" : "text-muted hover:text-primary"
              )}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button 
              onClick={() => setViewMode('grid')}
              title="Vista Cuadrícula Compacta"
              aria-label="Vista cuadrícula"
              aria-pressed={viewMode === 'grid'}
              className={cn(
                "min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-1.5 rounded-md transition-all",
                viewMode === 'grid' ? "bg-primary text-indigo-600 shadow-xs ring-1 ring-black/5" : "text-muted hover:text-primary"
              )}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <section className="inventory-category-action" aria-label="Gestión de categorías">
        <div className="inventory-category-action__icon"><Tag className="w-4 h-4" /></div>
        <div className="min-w-0 flex-1">
          <strong>Agregar categorías</strong>
          <span>Crea y organiza las categorías de tu inventario sin mezclar esta acción con los filtros.</span>
        </div>
        <button type="button" onClick={() => setShowCategoryModal(true)} className="inventory-category-action__button">
          <Tag className="w-3.5 h-3.5" /> Gestionar
        </button>
      </section>

      {/* Tabs - High contrast and modern segmented design */}
      <div className="inventory-section-tabs flex items-center gap-1.5 bg-secondary p-1 rounded-xl border border-base shrink-0 w-full shadow-xs">
        <div className="flex items-center gap-1.5 min-w-max">
          {(['products', 'restock', 'bulk'] as const)
            .map(tab => {
            const isActive = activeTab === tab;
            return (
              <button 
                key={tab}
                onClick={() => setActiveTab(tab as any)}
                className={cn(
                  "whitespace-nowrap px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer",
                  isActive 
                    ? "bg-indigo-600 text-white shadow-xs ring-1 ring-indigo-500/20" 
                    : "text-secondary hover:text-primary hover:bg-subtle"
                )}
              >
                <>{tab === 'products' ? <Package className="w-3.5 h-3.5" /> : tab === 'restock' ? <AlertCircle className="w-3.5 h-3.5" /> : <Settings2 className="w-3.5 h-3.5" />}<span>{tab === 'products' ? 'Existencias' : tab === 'restock' ? 'Alertas' : 'Edición Masiva'}</span></>
              </button>
            );
        })}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'excel' && !canExcel && (
        <PlanFeatureGate feature="excel_exports" title="Descarga de inventario en Excel" description="Exporta tu inventario completo a Microsoft Excel con información de productos, precios y existencias. Disponible desde Ciudadela." highlights={[
          "Existencias, precios y costos en un solo archivo",
          "Compatible con Microsoft Excel",
          "Ideal para análisis externo o respaldo"
        ]} />
      )}
      {activeTab === 'labels' && (canLabels ? <PrintLabels /> : <PlanFeatureGate feature="labels" title="Etiquetas de inventario" description="Genera e imprime etiquetas de productos desde PALMYRA. Esta herramienta avanzada está disponible desde Ciudadela." highlights={[
        "Etiquetas con código de barras y precio",
        "Elige producto, presentación y cantidad",
        "Ahorra tiempo en la reposición"
      ]} />)}
      {activeTab === 'abc' && (canABC ? <ABCAnalysis /> : <PlanFeatureGate feature="abc_analysis" title="Análisis ABC" description="Clasifica tus productos por importancia y rendimiento para tomar mejores decisiones de inventario. Disponible desde Ciudadela." highlights={[
        "Clasifica productos A, B y C por rotación",
        "Detecta qué artículos concentran tus ventas",
        "Prioriza compras y capital de trabajo"
      ]} />)}
      {activeTab === 'restock' && <RestockAlerts />}

      {activeTab === 'bulk' && (
        <div className="inventory-bulk-panel flex-1 min-h-0 bg-white dark:bg-slate-900 rounded-3xl shadow-xl border border-base overflow-hidden animate-in fade-in zoom-in-95 duration-300 flex flex-col">
          <div className="p-4 border-b border-base bg-slate-50/50 dark:bg-slate-800/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0">
            <div className="flex items-center gap-4">
              <div>
                <h2 className="text-sm font-black text-primary uppercase tracking-tight">Edición Masiva</h2>
                <p className="text-[10px] font-bold text-muted uppercase">Actualiza precios y salarios por producto rápidamente</p>
              </div>
              <label className="flex items-center gap-2 text-[10px] font-black uppercase text-secondary">
                Ordenar precio
                <select value={bulkPriceSort} onChange={event => setBulkPriceSort(event.target.value as 'none' | 'asc' | 'desc')} className="rounded-lg border border-base bg-primary px-2 py-2 text-[10px] font-bold text-primary">
                  <option value="none">Orden original</option>
                  <option value="asc">Menor a mayor</option>
                  <option value="desc">Mayor a menor</option>
                </select>
              </label>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              {Object.keys(bulkChanges).length > 0 && (
                <button
                  onClick={() => setBulkChanges({})}
                  className="px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-300 transition-all cursor-pointer"
                >
                  Descartar ({Object.keys(bulkChanges).length})
                </button>
              )}
              <button
                disabled={isSavingBulk || Object.keys(bulkChanges).length === 0}
                onClick={saveBulkChanges}
                className="flex-1 sm:flex-initial px-6 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2 cursor-pointer"
              >
                {isSavingBulk ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Guardar Cambios
              </button>
            </div>
          </div>

          <div className="inventory-bulk-scroll flex-1 min-h-0 overflow-y-auto overflow-x-auto overscroll-contain touch-pan-y">
            {/* Mobile-first cards: the desktop table's 700px minimum width hid fields off-screen on phones. */}
            <div className="grid grid-cols-1 gap-3 p-3 md:hidden">
              {bulkVisibleProducts.map(product => {
                const rowKey = `${product.id}:::global`;
                const changes = bulkChanges[rowKey] || {};
                return (
                  <article key={product.id} className="rounded-2xl border border-base bg-primary p-3 shadow-sm min-w-0">
                    <div className="flex items-start gap-3 mb-3">
                      <div className={cn("w-10 h-10 shrink-0 rounded-xl flex items-center justify-center text-sm font-bold", product.color || 'bg-slate-100')}>
                        {product.name.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <input type="text" aria-label={`Nombre del producto ${product.name}`} value={changes.name !== undefined ? changes.name : product.name} onChange={(e) => handleBulkChange(rowKey, 'name', e.target.value)} placeholder="Nombre del producto" className={cn("w-full min-w-0 px-3 py-2 bg-primary border rounded-xl text-sm font-black outline-none focus:ring-2 focus:ring-indigo-500", changes.name !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base")} />
                        <p className="mt-1 text-[10px] font-bold text-muted break-words">{categoryById.get(product.categoryId)?.name || 'Sin Categoría'} · {product.sku || 'SIN SKU'}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block min-w-0">
                        <span className="mb-1.5 block text-[10px] font-black text-secondary uppercase">Precio de venta ({baseCurrency.symbol})</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={changes.price !== undefined ? changes.price : product.price}
                          onChange={(e) => handleBulkChange(rowKey, 'price', parseFloat(e.target.value) || 0)}
                          className={cn("w-full min-w-0 px-3 py-3 bg-primary border rounded-xl text-base font-black outline-none focus:ring-2 focus:ring-indigo-500", changes.price !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base")}
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className="mb-1.5 block text-[10px] font-black text-secondary uppercase">Salario / comisión (CUP)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={changes.commissionValue !== undefined ? changes.commissionValue : (product.commissionValue || 0)}
                          onChange={(e) => handleBulkChange(rowKey, 'commissionValue', parseFloat(e.target.value) || 0)}
                          className={cn("w-full min-w-0 px-3 py-3 bg-primary border rounded-xl text-base font-black outline-none focus:ring-2 focus:ring-indigo-500", changes.commissionValue !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base")}
                        />
                      </label>
                    </div>
                  </article>
                );
              })}
              {bulkVisibleProducts.length === 0 && (
                <div className="py-12 text-center text-sm font-bold text-muted">No hay productos que coincidan con la búsqueda.</div>
              )}
            </div>
            <table aria-label="Productos en edición masiva" className="hidden md:table w-full text-left border-collapse min-w-[700px]">
              <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800 border-b border-base">
                <tr>
                  <th scope="col" className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest">Producto</th>
                  <th scope="col" className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest">SKU</th>
                  <th scope="col" className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-center">Precio de Venta ({baseCurrency.symbol})</th>
                  <th scope="col" className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-center">Salario/Comisión (CUP)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {bulkVisibleProducts.map(product => {
                  const rowKey = `${product.id}:::global`;
                  const changes = bulkChanges[rowKey] || {};
                  
                  return (
                    <tr key={product.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold", product.color || 'bg-slate-100')}>
                            {product.name.charAt(0)}
                          </div>
                          <div>
                            <input type="text" aria-label={`Nombre del producto ${product.name}`} value={changes.name !== undefined ? changes.name : product.name} onChange={(e) => handleBulkChange(rowKey, 'name', e.target.value)} className={cn("w-full min-w-[180px] px-2 py-2 bg-primary border rounded-lg text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500", changes.name !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base")} />
                            <div className="text-[8px] font-bold text-muted uppercase tracking-tighter">
                              {categoryById.get(product.categoryId)?.name || 'Sin Categoría'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[10px] font-black text-secondary uppercase tracking-tight">
                          {product.sku || 'SIN SKU'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center">
                          <input
                            type="number"
                            aria-label={`Precio de venta de ${product.name}`}
                            value={changes.price !== undefined ? changes.price : product.price}
                            onChange={(e) => handleBulkChange(rowKey, 'price', parseFloat(e.target.value) || 0)}
                            className={cn(
                              "w-32 px-3 py-2 bg-white dark:bg-slate-800 border rounded-xl text-xs font-black text-center outline-none focus:ring-2 focus:ring-indigo-500",
                              changes.price !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base shadow-sm"
                            )}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center">
                          <input
                            type="number"
                            aria-label={`Comisión de ${product.name}`}
                            value={changes.commissionValue !== undefined ? changes.commissionValue : (product.commissionValue || 0)}
                            onChange={(e) => handleBulkChange(rowKey, 'commissionValue', parseFloat(e.target.value) || 0)}
                            className={cn(
                              "w-32 px-3 py-2 bg-white dark:bg-slate-800 border rounded-xl text-xs font-black text-center outline-none focus:ring-2 focus:ring-indigo-500",
                              changes.commissionValue !== undefined ? "border-amber-500 ring-1 ring-amber-500" : "border-base shadow-sm"
                            )}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          {products.length === 0 && (
            <div className="py-20 text-center shrink-0">
              <Package className="w-12 h-12 text-slate-200 mx-auto mb-4" />
              <p className="text-xs font-bold text-muted uppercase">No se encontraron datos para editar</p>
            </div>
          )}
        </div>
      )}
      {activeTab === 'products' && (
        viewMode === 'table' ? (
          <div className="bg-secondary rounded-[2rem] shadow-sm border border-base overflow-hidden flex-1 flex flex-col min-h-[500px] w-full">
          <div className="overflow-x-auto overflow-y-auto flex-1 h-full custom-scrollbar w-full">
            <table aria-label="Productos del inventario" className="w-full text-left border-collapse table-fixed min-w-[1040px]">
              <thead>
                <tr className="bg-secondary border-b border-base sticky top-0 z-30 shadow-sm translate-y-[-1px]">
                  <th scope="col" className="w-14 px-4 py-3 bg-secondary">
                    <input 
                      type="checkbox" 
                      aria-label="Seleccionar todos los productos"
                      className="rounded border-base text-indigo-600 focus:ring-indigo-500 bg-primary"
                      checked={selectedItems.length === inventoryView.length && inventoryView.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedItems(inventoryView.map(i => i.id));
                        else setSelectedItems([]);
                      }}
                    />
                  </th>
                  <th scope="col" className="w-1/4 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Producto / Cat</th>
                  <th scope="col" className="w-36 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">SKU / CB</th>
                  <th scope="col" className="hidden xl:table-cell w-24 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Garantía</th>
                  <th scope="col" className="w-32 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Precio (CUP)</th>
                  <th scope="col" className="w-32 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Costo (CUP)</th>
                  <th scope="col" className="w-36 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary" title="Ganancia neta por unidad: venta − costo − salario">Ganancia neta</th>
                  <th scope="col" className="hidden xl:table-cell w-24 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">% margen</th>
                  <th scope="col" className="w-36 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Stock actual</th>
                  <th scope="col" className="w-28 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-right bg-secondary">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle">
                {inventoryView.map((item) => (
                  <tr key={item.id} className={cn(
                    "hover:bg-subtle/50 transition-colors group",
                    selectedItems.includes(item.id) && "bg-indigo-50/30 dark:bg-indigo-900/10"
                  )}>
                    <td className="px-4 py-3">
                      <input 
                        type="checkbox" 
                        aria-label={`Seleccionar ${item.name}`}
                        checked={selectedItems.includes(item.id)}
                        onChange={() => {
                          setSelectedItems(prev => prev.includes(item.id) ? prev.filter(id => id !== item.id) : [...prev, item.id]);
                        }}
                        className="rounded border-base text-indigo-600 focus:ring-indigo-500 bg-primary"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-subtle flex items-center justify-center overflow-hidden shrink-0 border border-base relative shadow-sm">
                          {item.image ? (
                            <img 
                              src={item.image} 
                              alt={item.name} 
                              className="w-full h-full object-cover" 
                              referrerPolicy="no-referrer" 
                              onError={(e) => {
                                e.currentTarget.onerror = null;
                                e.currentTarget.src = '';
                                e.currentTarget.style.display = 'none';
                              }}
                             loading="lazy" decoding="async" />
                          ) : (
                            <div className={cn("w-full h-full opacity-20", item.color)} />
                          )}
                          {!item.image && (
                            <span className="absolute text-[10px] font-black text-muted uppercase">
                              {item.name.substring(0, 2)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <div className="text-xs font-black text-primary uppercase tracking-tighter truncate flex items-center gap-1.5" title={item.name}>
                            {item.name}
                            {((item.availableSizes || []).length > 0 || (item.availableColors || []).length > 0) && (
                              <span title="Este producto tiene variantes" className="inline-flex items-center rounded-md bg-violet-50 px-1 py-0.5 text-[6px] font-black uppercase text-violet-700 border border-violet-100 shrink-0">Variantes</span>
                            )}
                            {item.isLowStock && (
                              <span title="Bajo Stock" className="inline-flex items-center">
                                <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" />
                              </span>
                            )}
                          </div>
                          <span className="text-[9px] text-muted font-bold uppercase truncate">{categoryById.get(item.categoryId)?.name || 'General'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[9px] font-mono font-black text-primary uppercase truncate">{item.sku}</div>
                      <div className="text-[7px] text-muted font-mono truncate">{item.barcode || '---'}</div>
                    </td>
                    <td className="hidden xl:table-cell px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className={cn("w-3 h-3", item.warrantyDays ? "text-emerald-500" : "text-slate-300 dark:text-slate-600")} />
                        <span className="text-[9px] font-bold text-secondary">
                          {item.warrantyDays ? `${item.warrantyDays}d` : '---'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[10px] font-black text-primary whitespace-nowrap">{formatMoney(item.price)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[10px] font-black text-secondary whitespace-nowrap">{formatMoney(item.costPrice)}</div>
                      <EquivalentLines
                        className="mt-0.5 text-[8px] font-bold text-muted"
                        parts={formatCurrencyEquivalentParts(equivalentsFor(item.costPrice))}
                        title="Costo por unidad en USD/EUR con las tasas activas"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className={cn("text-[10px] font-black whitespace-nowrap", profitToneClass(item.unitNetProfit))}
                        title="Ganancia neta por unidad: venta − costo − salario"
                      >{formatSignedMoney(item.unitNetProfit)}</div>
                      <EquivalentLines
                        className="mt-0.5 text-[8px] font-bold text-muted"
                        parts={formatCurrencyEquivalentParts(equivalentsFor(item.unitNetProfit), { signed: true })}
                        title="Ganancia neta por unidad en USD/EUR con las tasas activas"
                      />
                    </td>
                    <td className="hidden xl:table-cell px-4 py-3">
                      <div
                        className={cn("text-[10px] font-black whitespace-nowrap", profitToneClass(item.unitMarginPct))}
                        title="Margen sobre el precio de venta"
                      >{formatMarginPct(item.unitMarginPct)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={cn(
                          "px-2 py-0.5 rounded-lg text-[9px] font-black inline-block w-fit whitespace-nowrap",
                          item.totalStock === 0 ? "bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400" :
                          item.isLowStock ? "bg-amber-100 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400" : 
                          "bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400"
                        )}>
                          {item.totalStock} {item.unit || 'uds'}
                        </span>
                        {item.variantLevels.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {item.variantLevels.slice(0, 3).map((lvl, idx) => (
                              <span key={idx} className="text-[8px] font-bold text-slate-400 uppercase bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100">
                                {lvl.variantLabel}: {lvl.quantity}
                              </span>
                            ))}
                            {item.variantLevels.length > 3 && (
                              <span className="text-[7px] font-black text-slate-300 uppercase">+{item.variantLevels.length - 3}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <button 
                          onClick={() => {
                            const { totalStock, isLowStock, levels, unitNetProfit, unitMarginPct, ...productOnly } = item as any;
                            openStockManager(productOnly);
                          }}
                          className="text-muted hover:text-emerald-600 transition-colors p-1.5 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-950/50 border border-base shadow-sm"
                          title="Gestionar Stock"
                          aria-label={`Gestionar stock de ${item.name}`}
                        >
                          <PackagePlus className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => {
                            const { totalStock, isLowStock, levels, unitNetProfit, unitMarginPct, ...productOnly } = item as any;
                            setEditingProduct(productOnly);
                            setFormData(productOnly);
                            setShowAddModal(true);
                          }}
                          className="text-muted hover:text-indigo-600 transition-colors p-1.5 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-950/50 border border-base shadow-sm"
                          aria-label={`Editar ${item.name}`}
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => setPendingDelete({ kind: 'product', id: item.id, name: item.name })}
                          className="text-muted hover:text-rose-600 transition-colors p-1.5 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/50 border border-base shadow-sm"
                          aria-label={`Eliminar ${item.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {inventoryView.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-6 py-16">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <Package className="w-10 h-10 text-slate-300 dark:text-slate-600" aria-hidden="true" />
                        <p className="text-xs font-black text-primary uppercase tracking-wide">Sin productos en esta vista</p>
                        <p className="max-w-sm text-[11px] font-bold text-muted">
                          {hasActiveFilters
                            ? 'Ningún producto coincide con la búsqueda o los filtros activos. Ajusta la sucursal, la categoría o el estado del stock.'
                            : 'Todavía no hay productos. Usa «Agregar producto» para crear el primero.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
            
            {inventoryData.full.length > displayLimit && (
              <div className="p-4 border-t border-base flex justify-center bg-secondary">
                <button 
                  onClick={() => setDisplayLimit(prev => prev + 200)}
                  className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md active:scale-95"
                >
                  Cargar más productos ({inventoryData.full.length - displayLimit} restantes)
                </button>
              </div>
            )}

            {/* Table Footer / Batch Actions */}
            {selectedItems.length > 0 && (
              <div className="bg-indigo-600 p-4 flex items-center justify-between text-white animate-in slide-in-from-bottom-full duration-300">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-bold">{selectedItems.length} seleccionados</span>
                  <div className="h-4 w-px bg-indigo-400" />
                  <button 
                    onClick={() => handleBatchUpdateStatus('active')}
                    className="text-xs font-black uppercase tracking-widest hover:text-indigo-200 transition-colors"
                  >
                    Marcar Activo
                  </button>
                  <button 
                    onClick={() => handleBatchUpdateStatus('discontinued')}
                    className="text-xs font-black uppercase tracking-widest hover:text-amber-200 transition-colors"
                  >
                    Descontinuar
                  </button>
                  <button 
                    onClick={() => setShowBatchPriceModal(true)}
                    className="text-xs font-black uppercase tracking-widest hover:text-emerald-200 transition-colors"
                  >
                    Ajustar Precios
                  </button>
                </div>
                <button onClick={() => setSelectedItems([])} className="text-xs font-black uppercase tracking-widest hover:text-indigo-200">Cancelar</button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col bg-secondary rounded-[2rem] border border-base shadow-sm overflow-hidden p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3 overflow-y-auto pr-2 flex-1 custom-scrollbar">
              {inventoryView.map((item) => (
                <div 
                  key={item.id} 
                  onClick={() => {
                    const { totalStock, isLowStock, levels, unitNetProfit, unitMarginPct, ...productOnly } = item as any;
                    setEditingProduct(productOnly);
                    setFormData(productOnly);
                    setShowAddModal(true);
                  }}
                  className="bg-primary p-2.5 rounded-2xl border border-base shadow-xs hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer group flex flex-col gap-1.5 h-fit relative"
                >
                  <div className="flex justify-between items-start gap-1">
                    <h3 className="text-[10px] font-black text-primary uppercase tracking-tight line-clamp-2 leading-tight flex-1 break-words" title={item.name}>{item.name}</h3>
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0 mt-0.5",
                      item.totalStock === 0 ? "bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.5)]" :
                      item.isLowStock ? "bg-amber-500" : "bg-emerald-500"
                    )} />
                  </div>
                  
                  <div className="flex items-center justify-between mt-auto">
                    <p className="text-[9px] font-black text-indigo-600 truncate tabular-nums" title={formatMoney(item.price)}>{formatMoney(item.price)}</p>
                    <p className={cn(
                      "text-[9px] font-black px-1.5 py-0.5 rounded-lg",
                      item.isLowStock ? "bg-rose-50/50 text-rose-600" : "bg-emerald-50/50 text-emerald-600"
                    )}>{item.totalStock}</p>
                  </div>

                  <div className="flex flex-col gap-1 border-t border-base pt-1">
                    <div className="flex items-baseline justify-between gap-2 text-[9px] font-bold">
                      <span className="text-muted uppercase tracking-wide shrink-0">Costo</span>
                      <span className="text-secondary font-black text-right break-words tabular-nums">{formatMoney(item.costPrice, baseCurrency, false)}</span>
                    </div>
                    <EquivalentLines
                      className="text-[8px] font-bold text-muted"
                      parts={formatCurrencyEquivalentParts(equivalentsFor(item.costPrice))}
                      title="Costo por unidad en USD/EUR con las tasas activas"
                    />
                    <div className="flex items-baseline justify-between gap-2 text-[9px] font-bold">
                      <span className="text-muted uppercase tracking-wide shrink-0">Ganancia</span>
                      <span
                        className={cn("font-black text-right break-words tabular-nums", profitToneClass(item.unitNetProfit))}
                        title="Ganancia neta por unidad: venta − costo − salario"
                      >{formatSignedMoney(item.unitNetProfit, baseCurrency, false)}</span>
                    </div>
                    <EquivalentLines
                      className="text-[8px] font-bold text-muted"
                      parts={formatCurrencyEquivalentParts(equivalentsFor(item.unitNetProfit), { signed: true })}
                      title="Ganancia neta por unidad en USD/EUR con las tasas activas"
                    />
                    <div className="flex items-center justify-between gap-2 text-[9px] font-bold">
                      <span className="text-muted uppercase tracking-wide">% margen</span>
                      <span
                        className={cn("font-black tabular-nums", profitToneClass(item.unitMarginPct))}
                        title="Margen sobre el precio de venta"
                      >{formatMarginPct(item.unitMarginPct)}</span>
                    </div>
                  </div>

                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      const { totalStock, isLowStock, levels, unitNetProfit, unitMarginPct, ...productOnly } = item as any;
                      openStockManager(productOnly);
                    }}
                    aria-label={`Gestionar stock de ${item.name}`}
                    title="Gestionar stock"
                    className="absolute -top-1.5 -right-1.5 flex h-9 w-9 items-center justify-center bg-white border border-base rounded-xl text-slate-500 hover:text-indigo-600 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <PackagePlus className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              
              {inventoryView.length === 0 && (
                <div className="col-span-full flex flex-col items-center gap-2 py-14 text-center">
                  <Package className="w-10 h-10 text-slate-300 dark:text-slate-600" aria-hidden="true" />
                  <p className="text-xs font-black text-primary uppercase tracking-wide">Sin productos en esta vista</p>
                  <p className="max-w-sm text-[11px] font-bold text-muted">
                    {hasActiveFilters
                      ? 'Ningún producto coincide con la búsqueda o los filtros activos.'
                      : 'Todavía no hay productos. Usa «Agregar producto» para crear el primero.'}
                  </p>
                </div>
              )}

              {inventoryData.full.length > displayLimit && (
                <div className="col-span-full py-4 flex justify-center">
                  <button 
                    onClick={() => setDisplayLimit(prev => prev + 200)}
                    className="px-8 py-2.5 bg-indigo-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md active:scale-95"
                  >
                    Ver más ({inventoryData.full.length - displayLimit} restantes)
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 z-[200] bg-slate-950/70 backdrop-blur-md p-1 md:p-4 flex items-center justify-center overflow-hidden"
          style={{
            top: 'var(--palmyra-vv-top, 0px)',
            bottom: 'auto',
            height: 'var(--palmyra-vv-height, 100dvh)',
            paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
            paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
            overscrollBehavior: 'none'
          }}
        >
          <div className="absolute inset-0" aria-hidden="true" />
          <div className="team-employee-modal inventory-product-modal relative z-10 w-full max-w-5xl bg-secondary border border-base rounded-[28px] shadow-2xl overflow-hidden flex flex-col min-h-0"
            style={{
              maxHeight: 'calc(var(--palmyra-vv-height, 100dvh) - 1rem)'
            }}>
            <header className="team-employee-modal-head relative overflow-hidden shrink-0">
              
              <div className="flex items-start gap-3 min-w-0">
                <div className="team-employee-hero-icon" aria-hidden="true"><PackagePlus className="w-5 h-5" /></div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="team-employee-kicker">Inventario · Alta de producto</span>
                    <span className="team-employee-status"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Ficha guiada</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-black text-primary tracking-tight mt-1">
                  {editingProduct ? 'Editar Producto' : 'Nuevo Producto'}
                </h2>
                <p className="text-[11px] sm:text-xs text-muted mt-1.5 leading-5 max-w-xl">Completa la información básica, configura variantes y termina con precios y alertas. Puedes avanzar por cada etapa sin perder lo escrito.</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowAddModal(false); setEditingProduct(null); setActiveFormTab('general'); }}
                className="w-10 h-10 rounded-2xl bg-subtle text-muted hover:text-primary hover:bg-primary border border-base flex items-center justify-center shrink-0 transition"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </header>

            <nav className="team-employee-stepbar" aria-label="Pasos para registrar producto">
              {[
                ['general','01','Producto','Datos básicos'],
                ['variants','02','Variantes','Tallas y colores'],
                ['extra','03','Precios','Extras y alertas']
              ].map(([id,num,label,sub], index) => (
                <React.Fragment key={id}>
                  <button type="button" className={cn("team-step-item", activeFormTab === id && "team-step-active", ['general','variants','extra'].indexOf(activeFormTab) > index && "team-step-done")} onClick={() => setActiveFormTab(id as any)}>
                    <span>{['general','variants','extra'].indexOf(activeFormTab) > index ? <span>✓</span> : num}</span>
                    <div><strong>{label}</strong><small>{sub}</small></div>
                  </button>
                  {index < 2 && <div className={cn("team-step-line", ['general','variants','extra'].indexOf(activeFormTab) > index && "is-complete")} />}
                </React.Fragment>
              ))}
            </nav>

            <form onSubmit={handleAddSubmit} className="flex-1 overflow-hidden flex flex-col">
              <div className="team-employee-modal-body flex-1 min-h-0 custom-scrollbar">
                {activeFormTab === 'general' && (
                  <div className="inventory-product-general">
                    <div className="inventory-product-general-grid">
                      <div className="inventory-product-photo">
                        <label className="inventory-product-label">Foto</label>
                        <div className="inventory-product-photo-box">
                          {formData.image ? (
                            <img src={formData.image} alt="Producto" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                          ) : (
                            <div className="inventory-product-photo-empty">
                              <Plus className="w-4 h-4" />
                              <span>Subir</span>
                            </div>
                          )}
                          <input type="file" accept="image/*" onChange={handleImageChange} aria-label="Subir foto del producto" />
                        </div>
                      </div>

                      <div className="inventory-product-fields">
                        <div className="inventory-product-row inventory-product-row-two">
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">Nombre</label>
                            <input
                              type="text"
                              required
                              value={formData.name || ''}
                              onChange={e => setFormData({...formData, name: e.target.value})}
                              className="inventory-product-input"
                              placeholder="Nombre comercial"
                            />
                          </div>
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">Categoría</label>
                            <select
                              required
                              value={formData.categoryId || ''}
                              onChange={e => setFormData({...formData, categoryId: e.target.value})}
                              className="inventory-product-input inventory-product-select"
                            >
                              <option value="">Seleccione...</option>
                              {(categories || []).map(c => <option key={c.id} value={c.id}>{c.department} - {c.name}</option>)}
                            </select>
                          </div>
                        </div>

                        <div className="inventory-product-row inventory-product-row-two">
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">SKU</label>
                            <div className="inventory-product-action-row">
                              <input
                                type="text"
                                required
                                value={formData.sku || ''}
                                onChange={e => setFormData({...formData, sku: e.target.value})}
                                className="inventory-product-input"
                                placeholder="SKU"
                              />
                              <button
                                type="button"
                                onClick={() => setFormData({...formData, sku: `SKU-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`})}
                                className="inventory-product-icon-button"
                                title="Autogenerar SKU"
                                aria-label="Autogenerar SKU"
                              >
                                <Settings2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">Código barras</label>
                            <div className="inventory-product-action-row">
                              <input
                                type="text"
                                value={formData.barcode || ''}
                                onChange={e => setFormData({...formData, barcode: e.target.value})}
                                className="inventory-product-input"
                                placeholder="EAN-13 / UPC"
                              />
                              <button
                                type="button"
                                onClick={() => setFormData({...formData, barcode: `750${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`})}
                                className="inventory-product-icon-button"
                                title="Autogenerar código de barras"
                                aria-label="Autogenerar código de barras"
                              >
                                <List className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="inventory-product-row inventory-product-row-two inventory-product-row-last">
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">Unidad</label>
                            <select
                              value={formData.unit || 'unidad'}
                              onChange={e => setFormData({...formData, unit: e.target.value})}
                              className="inventory-product-input inventory-product-select"
                            >
                              <option value="unidad">Unidad</option>
                              <option value="kg">Kilo</option>
                              <option value="m">Metro</option>
                              <option value="par">Par</option>
                            </select>
                          </div>
                          <div className="inventory-product-field">
                            <label className="inventory-product-label">Estado</label>
                            <select
                              value={formData.status || 'active'}
                              onChange={e => setFormData({...formData, status: e.target.value as any})}
                              className="inventory-product-input inventory-product-select"
                            >
                              <option value="active">Activo</option>
                              <option value="draft">Borrador</option>
                              <option value="discontinued">Descontinuado</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeFormTab === 'variants' && (
                  <div className="inventory-product-general inventory-product-step">
                    <div className="inventory-step-heading"><div><h3>Variantes</h3><p>Tallas, colores u otras presentaciones del producto.</p></div><InfoTooltip text="Cada variante tendrá su propia cantidad y mínimo de alerta cuando gestiones el stock." /></div>
                    <div className="inventory-variants-grid">
                      <div className="inventory-variant-group">
                        <div className="inventory-variant-head"><label className="inventory-product-label">Tallas</label><span>{(formData.availableSizes || []).length}</span></div>
                        <div className="inventory-product-action-row">
                          <input value={newSize} disabled={(formData.availableColors||[]).length>0} onChange={e=>setNewSize(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const value=newSize.trim();if(!value)return;setFormData(prev=>({...prev,availableSizes:Array.from(new Set([...(prev.availableSizes||[]),value]))}));setNewSize('');}}} className="inventory-product-input" placeholder={(formData.availableColors||[]).length>0?"No disponible con colores":"Ej. M, 40, 42"} />
                          <button type="button" disabled={(formData.availableColors||[]).length>0} onClick={()=>{const value=newSize.trim();if(!value)return;setFormData(prev=>({...prev,availableSizes:Array.from(new Set([...(prev.availableSizes||[]),value]))}));setNewSize('');}} className="inventory-product-small-button">Agregar</button>
                        </div>
                        <div className="inventory-variant-tags">{(formData.availableSizes||[]).map(size=><button type="button" key={size} onClick={()=>setFormData(prev=>({...prev,availableSizes:(prev.availableSizes||[]).filter(x=>x!==size)}))} className="inventory-variant-tag inventory-variant-tag-indigo">{size}<span>×</span></button>)}</div>
                      </div>
                      <div className="inventory-variant-group">
                        <div className="inventory-variant-head"><label className="inventory-product-label">Colores</label><span>{(formData.availableColors || []).length}</span></div>
                        <div className="inventory-product-action-row">
                          <input value={newColor} disabled={(formData.availableSizes||[]).length>0} onChange={e=>setNewColor(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const value=newColor.trim();if(!value)return;setFormData(prev=>({...prev,availableColors:Array.from(new Set([...(prev.availableColors||[]),value]))}));setNewColor('');}}} className="inventory-product-input" placeholder={(formData.availableSizes||[]).length>0?"No disponible con tallas":"Ej. Negro, Rojo"} />
                          <button type="button" disabled={(formData.availableSizes||[]).length>0} onClick={()=>{const value=newColor.trim();if(!value)return;setFormData(prev=>({...prev,availableColors:Array.from(new Set([...(prev.availableColors||[]),value]))}));setNewColor('');}} className="inventory-product-small-button">Agregar</button>
                        </div>
                        <div className="inventory-variant-tags">{(formData.availableColors||[]).map(color=><button type="button" key={color} onClick={()=>setFormData(prev=>({...prev,availableColors:(prev.availableColors||[]).filter(x=>x!==color)}))} className="inventory-variant-tag inventory-variant-tag-violet">{color}<span>×</span></button>)}</div>
                      </div>
                    </div>
                    <div className="inventory-step-note"><b>Una sola dimensión:</b> usa tallas <i>o</i> colores. Cada etiqueta tendrá su propio stock y el POS descontará exactamente esa variante.</div>
                    {(formData.availableSizes?.length||formData.availableColors?.length)?<div className="inventory-step-note"><b>Producto con variantes:</b> no habrá stock base. Después de guardar, asigna la cantidad de cada variante desde Gestionar stock.</div>:null}
                  </div>
                )}

                {activeFormTab === 'extra' && (
                  <div className="inventory-product-general inventory-product-step">
                    <div className="inventory-step-heading"><div><h3>Precios y extras</h3><p>Configura costos, venta, comisión, garantía y alertas.</p></div><InfoTooltip text="El precio de venta y el costo se utilizan para calcular automáticamente el margen." /></div>
                    <div className="inventory-price-grid">
                      <div className="inventory-price-group">
                        <div className="inventory-price-heading"><DollarSign className="w-3.5 h-3.5" /><span>Precios</span></div>
                        <div className="inventory-product-row inventory-product-row-two">
                          <div className="inventory-product-field"><label className="inventory-product-label">Costo compra · CUP</label><input type="number" min="0" value={formData.costPrice===0?'':(formData.costPrice??'')} placeholder="Opcional" onFocus={e=>e.target.select()} onChange={e=>handleCostPriceChange(e.target.value===''?0:(parseFloat(e.target.value)||0),formData.price||0)} className="inventory-product-input" /></div>
                          <div className="inventory-product-field"><label className="inventory-product-label">Precio venta · CUP</label><input type="number" required value={formData.price===0?'':(formData.price??'')} placeholder="0.00" onFocus={e=>e.target.select()} onChange={e=>handleCostPriceChange(formData.costPrice||0,e.target.value===''?0:(parseFloat(e.target.value)||0))} className="inventory-product-input inventory-product-price-input" /></div>
                        </div>
                        <div className="inventory-margin-row"><div><span>Margen de utilidad</span><strong>CUP {formData.margin?.toLocaleString()}</strong></div><TrendingUp className="w-4 h-4" /></div>
                        {hasFixedProductEmployees?<div className="inventory-product-field"><div className="inventory-label-with-info"><label className="inventory-product-label">Comisión vendedor · CUP fijo</label><InfoTooltip text="Monto fijo en CUP que recibe el vendedor por cada unidad vendida de este producto." /></div><input type="number" min="0" value={formData.commissionValue===0?'':(formData.commissionValue??'')} placeholder="0.00" onFocus={e=>e.target.select()} onChange={e=>setFormData({...formData,commissionValue:e.target.value===''?0:(parseFloat(e.target.value)||0)})} className="inventory-product-input" /></div>:<div className="inventory-step-note">Los empleados están configurados para <b>% sobre el total de venta</b>. La comisión fija por producto queda desactivada.</div>}
                      </div>
                      <div className="inventory-price-group">
                        <div className="inventory-price-heading"><ShieldCheck className="w-3.5 h-3.5" /><span>Garantía y alertas</span></div>
                        <div className="inventory-product-row inventory-product-row-two">
                          <div className="inventory-product-field"><label className="inventory-product-label">Días de garantía</label><input type="number" min="0" value={formData.warrantyDays===0?'':(formData.warrantyDays??'')} placeholder="0 = Sin garantía" onFocus={e=>e.target.select()} onChange={e=>setFormData({...formData,warrantyDays:e.target.value===''?0:(parseInt(e.target.value)||0)})} className="inventory-product-input" /></div>
                          <div className="inventory-product-field"><label className="inventory-product-label">Stock mínimo · alerta</label><input type="number" min="0" value={formData.minStockAlert===0?'':(formData.minStockAlert??'')} placeholder="5" onFocus={e=>e.target.select()} onChange={e=>setFormData({...formData,minStockAlert:e.target.value===''?0:(parseInt(e.target.value)||0)})} className="inventory-product-input" /></div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <footer className="team-employee-modal-footer">
                <div className="team-footer-icon" aria-hidden="true"><Package className="w-4 h-4" /></div>
                <p><strong>Paso {activeFormTab === 'general' ? '1' : activeFormTab === 'variants' ? '2' : '3'} de 3.</strong> {activeFormTab === 'general' ? 'Datos básicos.' : activeFormTab === 'variants' ? 'Configura variantes antes de continuar.' : 'Revisa precios, extras y alertas.'} Los datos se guardan al registrar el producto. Las existencias se gestionan después desde <strong>Gestionar stock</strong>.</p>
                <div className="team-footer-actions">
                <button 
                  type="button" 
                  onClick={() => { setShowAddModal(false); setEditingProduct(null); setActiveFormTab('general'); }} 
                  className="team-footer-secondary"
                >
                  Descartar
                </button>
                <button
                  type="submit"
                  className="team-footer-primary"
                >
                  {!editingProduct && activeFormTab !== 'extra' ? (
                    <>Siguiente <ChevronRight className="w-4 h-4" /></>
                  ) : (
                    <>{editingProduct ? 'Guardar Cambios' : 'Registrar Producto'} <Check className="w-4 h-4" /></>
                  )}
                </button>
                </div>
              </footer>
            </form>
          </div>
        </div>
      )}

      {/* Modal Nueva Categoría */}
      {/* (Categoría funcionalidad eliminada) */}

      {managingStockProduct && (
        <div className="fixed inset-x-0 bg-slate-900/70 backdrop-blur-sm z-50 flex justify-center items-center p-2 sm:p-4 stock-manage-overlay" style={{ top: `${stockViewport.top}px`, height: stockViewport.height ? `${stockViewport.height}px` : "100dvh" }}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 duration-200 overflow-hidden stock-manage-modal" style={{ maxHeight: stockViewport.height ? `${Math.max(160, stockViewport.height - 16)}px` : "calc(100dvh - 16px)", minHeight: 0 }}>
            <div className="flex justify-between items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 flex items-center justify-center shrink-0">
                  <PackagePlus className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight">Gestionar Stock</h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium truncate max-w-[280px] sm:max-w-md">{managingStockProduct.name}</p>
                </div>
              </div>
              <button 
                onClick={() => { commitAllStockDrafts(); setManagingStockProduct(null); }} 
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="p-4 overflow-y-auto custom-scrollbar flex-1 min-h-0 bg-white dark:bg-slate-900 stock-manage-scroll" style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
              <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                <span>Arrastra las tarjetas para ordenarlas o usa las flechas en cada almacén.</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {orderedBranches.map((branch, branchIndex) => {
                  const hasVariants =
                    (managingStockProduct.availableSizes || []).length > 0 ||
                    (managingStockProduct.availableColors || []).length > 0;
                  const productVariants = Array.from(new Set([
                    ...(hasVariants ? [] : [undefined]),
                    ...(managingStockProduct.availableSizes || []),
                    ...(managingStockProduct.availableColors || [])
                  ]));

                  // Calculate total in this branch
                  const totalInBranch = productVariants.reduce((sum, v) => {
                    const lev = inventory.find(i => 
                      i.productId === managingStockProduct.id && 
                      i.branchId === branch.id && 
                      (i.variantLabel || '') === (v || '')
                    );
                    return sum + (lev?.quantity || 0);
                  }, 0);

                  return (
                    <div
                      key={branch.id}
                      draggable={orderedBranches.length > 1}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', branch.id);
                      }}
                      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const draggedId = event.dataTransfer.getData('text/plain');
                        if (!draggedId || draggedId === branch.id) return;
                        const order = orderedBranches.map(candidate => candidate.id);
                        const fromIndex = order.indexOf(draggedId);
                        const toIndex = order.indexOf(branch.id);
                        if (fromIndex < 0 || toIndex < 0) return;
                        order.splice(fromIndex, 1);
                        order.splice(toIndex, 0, draggedId);
                        setWarehouseCardOrder(order);
                      }}
                      className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700/60 space-y-2.5 flex flex-col justify-between cursor-move"
                      title="Arrastra para cambiar la posición del almacén"
                    >
                      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-200 dark:border-slate-700/60">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Building2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                          <p className="text-xs font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight truncate">{getBranchDisplayName(branch)}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button type="button" onClick={(event) => { event.stopPropagation(); moveWarehouseCard(branch.id, -1); }} disabled={branchIndex === 0} aria-label={`Mover ${branch.name} antes`} title="Mover antes" className="w-6 h-6 rounded-md border border-base bg-primary text-secondary hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed">
                            <ChevronUp className="w-3 h-3 mx-auto" />
                          </button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); moveWarehouseCard(branch.id, 1); }} disabled={branchIndex === orderedBranches.length - 1} aria-label={`Mover ${branch.name} después`} title="Mover después" className="w-6 h-6 rounded-md border border-base bg-primary text-secondary hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed">
                            <ChevronDown className="w-3 h-3 mx-auto" />
                          </button>
                          <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200/50 dark:border-indigo-800/50">
                            {totalInBranch} uds
                          </span>
                        </div>
                      </div>
                      
                      <div className="space-y-1.5 flex-1">
                        {productVariants.map(variant => {
                          const level = inventory.find(i => 
                            i.productId === managingStockProduct.id && 
                            i.branchId === branch.id && 
                            (i.variantLabel || '') === (variant || '')
                          ) || { quantity: 0, minQuantity: 5 };

                          return (
                            <div key={variant || 'base'} className="flex items-center justify-between gap-2 bg-white dark:bg-slate-800/90 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs">
                              <div className="min-w-0 flex-1">
                                <p className="text-[10px] font-bold text-slate-800 dark:text-slate-200 truncate">
                                  {variant ? variant : 'Stock Base'}
                                </p>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <label className="text-[8px] font-semibold text-slate-400 uppercase flex items-center gap-0.5">Mín: <InfoTooltip text="Solo sirve como umbral de alerta de stock bajo. No limita ni impide guardar una cantidad menor." /></label>
                                  <input 
                                    type="number" 
                                    min="0"
                                    aria-label={`Stock mínimo de ${variant || 'Stock Base'} en ${branch.name}`}
                                    value={readStockDraft(managingStockProduct.id, branch.id, variant, level.quantity, level.minQuantity).minQuantity} 
                                    placeholder="0"
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => updateStockDraft(managingStockProduct.id, branch.id, variant, 'minQuantity', e.target.value)}
                                     onBlur={() => undefined}
                                    className="w-10 px-1 py-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-[9px] text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-indigo-500 text-center font-bold"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <span className="text-[9px] font-semibold text-slate-400 uppercase">Cant:</span>
                                <input 
                                    type="number" 
                                    min="0"
                                    aria-label={`Cantidad de ${variant || 'Stock Base'} en ${branch.name}`}
                                    value={readStockDraft(managingStockProduct.id, branch.id, variant, level.quantity, level.minQuantity).quantity} 
                                    placeholder="0"
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => updateStockDraft(managingStockProduct.id, branch.id, variant, 'quantity', e.target.value)}
                                     onBlur={() => undefined}
                                     onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                                    className="w-16 px-2 py-1 bg-white dark:bg-slate-900 border border-indigo-400 dark:border-indigo-600 rounded-lg font-black text-indigo-600 dark:text-indigo-400 text-right outline-none text-xs focus:ring-2 focus:ring-indigo-500 shadow-2xs"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            
            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                Almacenes: <strong className="text-slate-900 dark:text-slate-100 font-bold">{allowedBranches.length}</strong>
              </span>
              <button 
                onClick={() => { commitAllStockDrafts(); setManagingStockProduct(null); }} 
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs transition-colors shadow-sm active:scale-95"
              >
                Cerrar y Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {showBatchPriceModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-center items-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight">Ajuste de Precios Masivo</h3>
              <button onClick={() => setShowBatchPriceModal(false)} className="p-2 hover:bg-slate-200 rounded-full transition-colors"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-slate-500 font-bold uppercase tracking-widest text-center mb-4">Afectando a {selectedItems.length} productos</p>
              
              <div className="grid grid-cols-2 gap-2">
                <button 
                  onClick={() => setBatchPriceAdjust({...batchPriceAdjust, direction: 'increase'})}
                  className={cn("py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all", batchPriceAdjust.direction === 'increase' ? "bg-emerald-100 text-emerald-700 ring-2 ring-emerald-500/20" : "bg-slate-50 text-slate-400 hover:bg-slate-100")}
                >Incrementar</button>
                <button 
                  onClick={() => setBatchPriceAdjust({...batchPriceAdjust, direction: 'decrease'})}
                  className={cn("py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all", batchPriceAdjust.direction === 'decrease' ? "bg-rose-100 text-rose-700 ring-2 ring-rose-500/20" : "bg-slate-50 text-slate-400 hover:bg-slate-100")}
                >Decrementar</button>
              </div>

              <div className="flex gap-2">
                <select 
                  value={batchPriceAdjust.type}
                  onChange={(e) => setBatchPriceAdjust({...batchPriceAdjust, type: e.target.value as any})}
                  className="flex-1 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-xs font-black uppercase outline-none"
                >
                  <option value="percentage">Porcentaje (%)</option>
                  <option value="fixed">Monto Fijo (CUP)</option>
                </select>
                <input 
                  type="number" 
                  value={batchPriceAdjust.value || ''}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setBatchPriceAdjust({...batchPriceAdjust, value: parseFloat(e.target.value) || 0})}
                  className="w-32 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-xs font-black outline-none focus:ring-2 focus:ring-indigo-500/20"
                  placeholder="0.00"
                />
              </div>

              <button 
                onClick={handleBatchPriceApply}
                className="w-full py-4 bg-indigo-600 text-white font-black uppercase tracking-widest text-xs rounded-2xl hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-[0.98] mt-4"
              >Aplicar Cambios</button>
            </div>
          </div>
        </div>
      )}

      {/* Kit Component Picker Modal */}
      {showKitPicker && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex justify-center items-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Seleccionar Componente</h3>
              <button onClick={() => setShowKitPicker(false)} className="p-1.5 hover:bg-slate-200 rounded-full transition-colors"><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="Buscar producto..." 
                  value={kitQuery}
                  onChange={e => setKitQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none"
                />
              </div>
              <div className="max-h-60 overflow-y-auto space-y-2 px-1 custom-scrollbar">
                {products
                  .filter(p => p && !p.isKit && (p.name.toLowerCase().includes(kitQuery.toLowerCase()) || p.sku.toLowerCase().includes(kitQuery.toLowerCase())))
                  .slice(0, 10)
                  .map(p => (
                    <button 
                      key={p.id}
                      type="button"
                      onClick={() => {
                        const existing = (formData.kitComponents || []).find(c => c.productId === p.id);
                        if (!existing) {
                          setFormData({
                            ...formData, 
                            kitComponents: [...(formData.kitComponents || []), { productId: p.id, quantity: 1 }]
                          });
                        }
                        setShowKitPicker(false);
                      }}
                      className="w-full flex items-center justify-between p-3 bg-white hover:bg-indigo-50 border border-slate-100 rounded-2xl transition-all"
                    >
                      <div className="text-left">
                        <p className="text-[10px] font-black text-slate-900 uppercase">{p.name}</p>
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-tight">{p.sku}</p>
                      </div>
                      <Plus className="w-4 h-4 text-indigo-400" />
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Modal Categorías */}
      {showCategoryModal && (
        <div
          className="fixed inset-x-0 z-[60] flex items-center justify-center bg-slate-900/60 p-3 sm:p-4"
          style={{
            top: categoryViewport.top,
            height: categoryViewport.height || undefined,
          }}
        >
          <div className="inventory-category-modal">
            <div className="inventory-category-header">
              <div className="inventory-category-title">
                <div className="inventory-category-icon"><Tag className="w-4 h-4" /></div>
                <div><h2>Agregar categorías</h2><p>Organiza tu catálogo de forma clara y rápida.</p></div>
              </div>
              <button type="button" onClick={()=>setShowCategoryModal(false)} className="inventory-category-close" aria-label="Cerrar"><X className="w-4 h-4" /></button>
            </div>
            <div className="inventory-category-body">
              <form onSubmit={handleCategorySubmit} className="inventory-category-form">
                <div className="inventory-category-form-grid">
                  <div className="inventory-product-field"><label className="inventory-product-label">Nombre</label><input required type="text" value={categoryFormData.name} onChange={e=>setCategoryFormData({...categoryFormData,name:e.target.value})} className="inventory-product-input" placeholder="Ej. Smartphones" /></div>
                  <div className="inventory-product-field"><label className="inventory-product-label">Departamento</label><input required type="text" value={categoryFormData.department} onChange={e=>setCategoryFormData({...categoryFormData,department:e.target.value})} className="inventory-product-input" placeholder="Ej. Electrónica" /></div>
                </div>
                <div className="inventory-category-actions">
                  {editingCategory && <button type="button" onClick={()=>{setEditingCategory(null);setCategoryFormData({name:"",department:""});}} className="inventory-category-cancel">Cancelar</button>}
                  <button type="submit" className="inventory-category-submit">{editingCategory?'Actualizar':'Agregar categoría'}</button>
                </div>
              </form>
              <div className="inventory-category-list">
                <div className="inventory-category-list-head"><span>Categorías existentes</span><span>{categories.length}</span></div>
                <div className="inventory-category-items">
                  {categories.map(cat=>(
                    <div key={cat.id} className="inventory-category-item">
                      <div className="inventory-category-item-info"><div className="inventory-category-item-icon"><Tag className="w-3.5 h-3.5" /></div><div className="min-w-0"><p>{cat.name}</p><span>{cat.department}</span></div></div>
                      <div className="inventory-category-item-actions">
                        <button type="button" onClick={()=>{setEditingCategory(cat);setCategoryFormData({name:cat.name,department:cat.department});}} title="Editar"><Edit className="w-3.5 h-3.5" /></button>
                        <button type="button" onClick={()=>setPendingDelete({kind:'category',id:cat.id,name:cat.name})} title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="inventory-delete-title">
          <div className="w-full max-w-md rounded-2xl border border-base bg-secondary p-5 shadow-xl animate-in zoom-in-95">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 id="inventory-delete-title" className="text-base font-bold text-primary">
                  {pendingDelete.kind === 'product' ? 'Eliminar producto' : 'Eliminar categoría'}
                </h3>
                <p className="mt-1 text-sm text-secondary">
                  {pendingDelete.kind === 'product'
                    ? <>«{pendingDelete.name}» saldrá del catálogo y del inventario. Las ventas históricas se conservan. Esta acción no se puede deshacer.</>
                    : <>«{pendingDelete.name}» se quitará del catálogo. Solo puedes eliminarla si ningún producto la está usando.</>}
                </p>
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => setPendingDelete(null)} className="min-h-10 flex-1 rounded-xl border border-base bg-primary text-sm font-bold text-secondary hover:bg-subtle">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pendingDelete.kind === 'product') deleteProduct(pendingDelete.id);
                  else deleteCategory(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="min-h-10 flex-1 rounded-xl bg-rose-600 text-sm font-bold text-white hover:bg-rose-700"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
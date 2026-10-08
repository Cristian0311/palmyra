import { buildInventoryViewData } from '../modules/inventory/utils/buildInventoryViewData';
import { getWarehouseId } from "../modules/warehouse/warehouseScope";
import { buildInventoryCsv } from '../modules/inventory/utils/buildInventoryCsv';
import { resizeProductImage } from '../modules/inventory/utils/resizeProductImage';
import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, PackagePlus, AlertCircle, Search, ShieldCheck, X, DollarSign, Trash2, Edit, History, Package, PackageCheck, TrendingUp, Filter, Download, Plus, ArrowRightLeft, LayoutGrid, List, Settings2, Tag, Building2, Save, RefreshCw, Minus, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useStore } from "../store/useStore";
import { cn, generateId } from "../lib/utils";
import { Product, Category } from "../types";
import { InfoTooltip } from "../components/InfoTooltip";
import { TransferHistory } from "../components/TransferHistory";
import { PrintLabels } from "../components/PrintLabels";
import { ABCAnalysis } from "../components/ABCAnalysis";
import { RestockAlerts } from "../components/RestockAlerts";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import * as XLSX from 'xlsx';
import { loadSaaSContext } from '../services/saas';
import { canUsePlanFeature } from '../services/planAccess';
import PlanFeatureGate from '../components/PlanFeatureGate';
import "./team.css";

export default function Inventory() {
  const { 
    products, inventory, branches, addProduct, updateProduct, 
    transferInventory, setInventoryQuantity, deleteProduct, deleteCategory,
    transfers, categories, batchDeleteProducts, batchUpdateProducts, getBaseCurrency, currencies,
    currentBranchId, addNotification, users
  } = useStore(useShallow((state) => ({ products: state.products, inventory: state.inventory, branches: state.branches, addProduct: state.addProduct, updateProduct: state.updateProduct, transferInventory: state.transferInventory, setInventoryQuantity: state.setInventoryQuantity, deleteProduct: state.deleteProduct, deleteCategory: state.deleteCategory, transfers: state.transfers, categories: state.categories, batchDeleteProducts: state.batchDeleteProducts, batchUpdateProducts: state.batchUpdateProducts, getBaseCurrency: state.getBaseCurrency, currencies: state.currencies, currentBranchId: state.currentBranchId, addNotification: state.addNotification, users: state.users })));
  const baseCurrency = getBaseCurrency();
  const hasFixedProductEmployees = (users || []).some(user => user.role === 'employee' && (user.compensationType || 'fixed_product') === 'fixed_product');
  const categoryById = useMemo(
    () => new Map((categories || []).map(category => [category.id, category])),
    [categories]
  );

  const getBranchDisplayName = (b: { id: string; name: string }) => {
    const assignedUser = (users || []).find(u => getWarehouseId(u) === b.id);
    return assignedUser ? `${b.name} (${assignedUser.name})` : b.name;
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [managingStockProduct, setManagingStockProduct] = useState<Product | null>(null);
  const [transferQuantity, setTransferQuantity] = useState<number>(0);
  const [targetBranchId, setTargetBranchId] = useState<string>("");
  const [transferVariant, setTransferVariant] = useState<string>("");

  const handleTransfer = async (productId: string, fromBranchId: string) => {
    if (!targetBranchId || transferQuantity <= 0) {
      addNotification("Selecciona una sucursal destino y una cantidad válida.", 'warning');
      return;
    }
    
    const success = await transferInventory(productId, fromBranchId, targetBranchId, transferQuantity, transferVariant);
    if (success) {
      addNotification("Transferencia completada con éxito.", 'success');
      setTransferQuantity(0);
      setTargetBranchId("");
    } else {
      addNotification("Error al realizar la transferencia. Verifica el stock disponible.", 'error');
    }
  };
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low' | 'out'>('all');
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'products' | 'transfers' | 'labels' | 'abc' | 'restock' | 'bulk' | 'excel'>('products');
  const [planCode, setPlanCode] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => { if (active) setPlanCode(ctx?.subscription?.planCode || null); }).catch(() => { if (active) setPlanCode(null); });
    return () => { active = false; };
  }, []);
  const [showBatchPriceModal, setShowBatchPriceModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categoryViewport, setCategoryViewport] = useState({ height: 0, top: 0 });


  useEffect(() => {
    if (!showAddModal || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const syncVisualViewport = () => {
      document.documentElement.style.setProperty('--palmyra-vv-height', `${viewport?.height || window.innerHeight}px`);
      document.documentElement.style.setProperty('--palmyra-vv-top', `${viewport?.offsetTop || 0}px`);
    };
    syncVisualViewport();
    viewport?.addEventListener('resize', syncVisualViewport);
    viewport?.addEventListener('scroll', syncVisualViewport);
    window.addEventListener('resize', syncVisualViewport);
    return () => {
      viewport?.removeEventListener('resize', syncVisualViewport);
      viewport?.removeEventListener('scroll', syncVisualViewport);
      window.removeEventListener('resize', syncVisualViewport);
      document.documentElement.style.removeProperty('--palmyra-vv-height');
      document.documentElement.style.removeProperty('--palmyra-vv-top');
    };
  }, [showAddModal]);

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
  const [bulkChanges, setBulkChanges] = useState<Record<string, { costPrice?: number, price?: number, quantity?: number, commissionValue?: number }>>({});
  const [isSavingBulk, setIsSavingBulk] = useState(false);
  const [bulkBranchId, setBulkBranchId] = useState<string>(branches[0]?.id || "");

  const [transferSubTab, setTransferSubTab] = useState<'history' | 'new'>('history');
  const [bulkTransferItems, setBulkTransferItems] = useState<{ productId: string, quantity: number, variant?: string }[]>([]);
  const [bulkTransferSourceId, setBulkTransferSourceId] = useState(currentBranchId);
  const [bulkTransferTargetId, setBulkTransferTargetId] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [isExecutingTransfer, setIsExecutingTransfer] = useState(false);

  // Auto-select first branch when they load
  React.useEffect(() => {
    if (!bulkBranchId && branches.length > 0) {
      setBulkBranchId(branches[0].id);
    }
  }, [branches, bulkBranchId]);

  const handleBulkChange = (id: string, field: 'costPrice' | 'price' | 'quantity' | 'commissionValue', value: number) => {
    const [prodId, branchId] = id.split(':::');
    
    setBulkChanges(prev => {
      const next = { ...prev };
      
      if (field === 'quantity') {
        // Quantity is branch-specific
        next[id] = { ...(next[id] || {}), [field]: value };
      } else {
        // Price/Cost/Commission are global for the product. Update ALL rows for this product.
        const productRows = Object.keys(next).filter(key => key.startsWith(`${prodId}:::`));
        
        if (productRows.length === 0) {
          next[id] = { ...(next[id] || {}), [field]: value };
        } else {
          productRows.forEach(key => {
            next[key] = { ...(next[key] || {}), [field]: value };
          });
        }
      }
      return next;
    });
  };

  const saveBulkChanges = async () => {
    setIsSavingBulk(true);
    try {
      const productUpdates: Record<string, { costPrice?: number, price?: number, commissionValue?: number }> = {};
      
      for (const [id, changes] of Object.entries(bulkChanges)) {
        const [prodId] = id.split(':::');
        
        if (changes.price !== undefined || changes.commissionValue !== undefined) {
          productUpdates[prodId] = {
            ...productUpdates[prodId],
            ...(changes.price !== undefined ? { price: changes.price } : {}),
            ...(changes.commissionValue !== undefined ? { commissionValue: changes.commissionValue } : {})
          };
        }
      }

      for (const [prodId, updates] of Object.entries(productUpdates)) {
        updateProduct(prodId, updates);
      }

      setBulkChanges({});
      addNotification("Cambios masivos guardados con éxito", 'success');
    } catch (err) {
      addNotification("Error al guardar cambios masivos", 'error');
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
      addProduct(newProduct);
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
    const csvContent = buildInventoryCsv(inventoryView, categories);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `inventario_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportToExcel = () => {
    const rows = inventoryView.map((item: any) => ({
      Producto: item.name || '',
      SKU: item.sku || '',
      'Código de barras': item.barcode || '',
      Categoría: categoryById.get(item.categoryId)?.name || '',
      'Precio de costo': Number(item.costPrice || 0),
      'Precio de venta': Number(item.price || 0),
      'Stock actual': Number(item.totalStock ?? item.quantity ?? 0),
      'Stock mínimo': Number(item.minQuantity || 0),
      'Valor de inventario': Number(item.costPrice || 0) * Number(item.totalStock ?? item.quantity ?? 0),
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    XLSX.writeFile(wb, `Inventario_PALMYRA_${new Date().toISOString().split('T')[0]}.xlsx`);
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

  const inventoryData = buildInventoryViewData(
    products || [],
    inventory || [],
    debouncedSearchQuery,
    selectedBranch,
    selectedCategory,
    stockFilter,
    displayLimit
  );

  const inventoryView = inventoryData.paginated;

  const formatMoney = (amount: number, currency = baseCurrency, withCode = true) => {
    const converted = currency.isBase ? amount : amount / (currency.rateToBase || 1);
    const formatted = converted.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (withCode) {
      return `${currency.code} ${currency.symbol}${formatted}`;
    }
    return `${currency.symbol} ${formatted}`;
  };

  const MultiCurrencyDisplay = ({ amount }: { amount: number }) => {
    const baseCurr = currencies.find(c => c.isBase) || baseCurrency;
    const secondaryCurr = currencies.filter(c => !c.isBase);
    const convertedBase = baseCurr.isBase ? amount : amount / (baseCurr.rateToBase || 1);
    const formattedBase = convertedBase.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    return (
      <div className="mt-0.5 space-y-0.5">
        <div className="text-[11px] font-black text-primary leading-tight truncate flex items-center gap-1">
          <span className="text-[7.5px] font-black px-1 py-0.2 rounded bg-indigo-100/70 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 uppercase tracking-tighter">
            {baseCurr.code}
          </span>
          <span>{baseCurr.symbol}{formattedBase}</span>
        </div>
        {secondaryCurr.length > 0 && (
          <div className="text-[8px] font-bold text-muted flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {secondaryCurr.map(c => {
              const val = amount / (c.rateToBase || 1);
              const formattedVal = val.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <span key={c.code} className="inline-flex items-center gap-0.5 whitespace-nowrap">
                  <span className="text-[6.5px] font-black uppercase text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-0.5 py-0.2 rounded">{c.code}</span>
                  <span className="text-[7.5px]">{c.symbol}{formattedVal}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const stats = useMemo(() => {
    const totalsByProduct = new Map<string, number>();
    for (const level of inventory || []) {
      if (selectedBranch !== 'all' && level.branchId !== selectedBranch) continue;
      totalsByProduct.set(level.productId, (totalsByProduct.get(level.productId) || 0) + level.quantity);
    }

    const targetProducts = selectedBranch === 'all'
      ? products.map(product => ({ ...product, totalStock: totalsByProduct.get(product.id) || 0 }))
      : inventoryData.full;

    const totalProducts = targetProducts.length;
    let totalStock = 0;
    let totalCostValue = 0;
    let totalSaleValue = 0;

    for (const product of targetProducts) {
      totalStock += product.totalStock;
      totalCostValue += product.costPrice * product.totalStock;
      totalSaleValue += product.price * product.totalStock;
    }

    const totalProfit = totalSaleValue - totalCostValue;
    const lowStockCount = inventoryData.full.filter(p => p.isLowStock).length;

    return { totalProducts, totalStock, lowStockCount, totalCostValue, totalSaleValue, totalProfit };
  }, [inventory, products, inventoryData.full, selectedBranch]);

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col min-h-0">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-2 px-1 shrink-0">
        <div>
          <h2 data-palmi-content="inventory" className="text-lg sm:text-xl font-black text-primary tracking-tight flex items-center gap-2 uppercase">
            Inventario
          </h2>
          <p className="text-[9px] sm:text-[10px] font-black text-muted uppercase tracking-widest">Stock Control</p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide w-full sm:w-auto py-1">
          <button 
            onClick={() => setActiveTab('products')}
            className="shrink-0 bg-emerald-600 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-emerald-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
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
            className="shrink-0 bg-indigo-600 text-white px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            Agregar producto
          </button>
          <button 
            onClick={() => canExcel ? exportToExcel() : setActiveTab('excel')}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 bg-secondary border border-base text-muted rounded-xl text-[9px] font-black uppercase tracking-wider hover:bg-subtle transition-all shadow-sm active:scale-95 whitespace-nowrap"
          >
            <Download className="w-3 h-3" />
            <span>{canExcel ? 'Excel' : 'Excel · Ciudadela'}</span>
          </button>
          <button 
            onClick={() => setActiveTab('labels')}
            className="shrink-0 bg-slate-900 dark:bg-slate-800 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-slate-800 dark:hover:bg-slate-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            {canLabels ? 'Etiquetas' : 'Etiquetas · Ciudadela'}
          </button>
          <button 
            onClick={() => setActiveTab('abc')}
            className="shrink-0 bg-blue-600 text-white px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 hover:bg-blue-700 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            {canABC ? 'Análisis ABC' : 'ABC · Ciudadela'}
          </button>

        </div>
      </header>

      {/* Summary Cards Lineal - Responsive Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 sm:gap-2 px-1 shrink-0">
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Tipos</span>
          <div className="text-[11px] font-black text-primary mt-0.5">{stats.totalProducts.toLocaleString()}</div>
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Costo</span>
          <div className="mt-0.5"><MultiCurrencyDisplay amount={stats.totalCostValue} /></div>
        </div>
        <div className="bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-muted tracking-wider">Venta</span>
          <div className="mt-0.5"><MultiCurrencyDisplay amount={stats.totalSaleValue} /></div>
        </div>
        <div className="bg-indigo-50/70 dark:bg-indigo-950/40 p-1.5 sm:p-2 rounded-xl border border-indigo-100 dark:border-indigo-900/40 shadow-xs flex flex-col justify-between">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-indigo-600 dark:text-indigo-400 tracking-wider">Ganancia</span>
          <div className="mt-0.5"><MultiCurrencyDisplay amount={stats.totalProfit} /></div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-secondary p-1.5 sm:p-2 rounded-xl border border-base shadow-xs flex flex-col justify-between">
          <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-rose-500 tracking-wider">Bajo Stock</span>
          <div className="text-[11px] font-black text-rose-600 dark:text-rose-400 mt-0.5">{stats.lowStockCount} alertas</div>
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
              placeholder="Buscar por nombre, SKU, código..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 h-8 bg-subtle border border-base text-primary rounded-xl text-[11px] font-semibold focus:bg-secondary focus:ring-1 focus:ring-indigo-500 outline-none transition-all placeholder:text-muted/60"
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
                className="w-full pl-6 pr-7 h-8 bg-subtle border border-base text-primary rounded-lg text-[9px] sm:text-[9px] font-bold outline-none hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
                title="Filtrar por sucursal"
              >
                <option value="all">Sucursal</option>
                {branches.map(b => (
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
                className="w-full pl-6 pr-5 h-7 bg-subtle border border-base text-primary rounded-lg text-[8px] sm:text-[9px] font-bold outline-none hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
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
                className="w-full px-6 pr-7 h-8 bg-subtle border border-base text-primary rounded-lg text-[9px] sm:text-[9px] font-bold outline-none hover:bg-secondary transition-colors cursor-pointer appearance-none truncate"
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
              className={cn(
                "p-1.5 rounded-md transition-all",
                viewMode === 'table' ? "bg-primary text-indigo-600 shadow-xs ring-1 ring-black/5" : "text-muted hover:text-primary"
              )}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button 
              onClick={() => setViewMode('grid')}
              title="Vista Cuadrícula Compacta"
              className={cn(
                "p-1.5 rounded-md transition-all",
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
        <PlanFeatureGate feature="excel_exports" title="Descarga de inventario en Excel" description="Exporta tu inventario completo a Microsoft Excel con información de productos, precios y existencias. Disponible desde Ciudadela." />
      )}
      {activeTab === 'labels' && (canLabels ? <PrintLabels /> : <PlanFeatureGate feature="labels" title="Etiquetas de inventario" description="Genera e imprime etiquetas de productos desde PALMYRA. Esta herramienta avanzada está disponible desde Ciudadela." />)}
      {activeTab === 'abc' && (canABC ? <ABCAnalysis /> : <PlanFeatureGate feature="abc_analysis" title="Análisis ABC" description="Clasifica tus productos por importancia y rendimiento para tomar mejores decisiones de inventario. Disponible desde Ciudadela." />)}
      {activeTab === 'restock' && <RestockAlerts />}

      {activeTab === 'bulk' && (
        <div className="inventory-bulk-panel flex-1 min-h-0 bg-white dark:bg-slate-900 rounded-3xl shadow-xl border border-base overflow-hidden animate-in fade-in zoom-in-95 duration-300 flex flex-col">
          <div className="p-4 border-b border-base bg-slate-50/50 dark:bg-slate-800/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0">
            <div className="flex items-center gap-4">
              <div>
                <h2 className="text-sm font-black text-primary uppercase tracking-tight">Edición Masiva</h2>
                <p className="text-[10px] font-bold text-muted uppercase">Actualiza precios y salarios por producto rápidamente</p>
              </div>
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
            <table className="w-full text-left border-collapse min-w-[700px]">
              <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800 border-b border-base">
                <tr>
                  <th className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest">Producto</th>
                  <th className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest">SKU</th>
                  <th className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-center">Precio de Venta ({baseCurrency.symbol})</th>
                  <th className="px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-center">Salario/Comisión (CUP)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {(debouncedSearchQuery.trim()
                  ? products.filter(p => {
                      const q = debouncedSearchQuery.trim().toLowerCase();
                      return p.name.toLowerCase().includes(q) ||
                        p.sku?.toLowerCase().includes(q) ||
                        p.barcode?.toLowerCase().includes(q);
                    })
                  : products
                ).map(product => {
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
                            <div className="text-[11px] font-black text-primary uppercase leading-tight">{product.name}</div>
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
            <table className="w-full text-left border-collapse table-fixed min-w-[950px]">
              <thead>
                <tr className="bg-secondary border-b border-base sticky top-0 z-30 shadow-sm translate-y-[-1px]">
                  <th className="w-14 px-4 py-3 bg-secondary">
                    <input 
                      type="checkbox" 
                      className="rounded border-base text-indigo-600 focus:ring-indigo-500 bg-primary"
                      checked={selectedItems.length === inventoryView.length && inventoryView.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedItems(inventoryView.map(i => i.id));
                        else setSelectedItems([]);
                      }}
                    />
                  </th>
                  <th className="w-1/4 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Producto / Cat</th>
                  <th className="w-36 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">SKU / CB</th>
                  <th className="w-28 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Garantía</th>
                  <th className="w-36 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Precio (CUP)</th>
                  <th className="w-40 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest bg-secondary">Stock Actual</th>
                  <th className="w-28 px-4 py-3 text-[9px] font-black text-muted uppercase tracking-widest text-right bg-secondary">Acciones</th>
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
                          <div className="text-xs font-black text-primary uppercase tracking-tighter truncate flex items-center gap-1.5">
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
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className={cn("w-3 h-3", item.warrantyDays ? "text-emerald-500" : "text-slate-300 dark:text-slate-600")} />
                        <span className="text-[9px] font-bold text-secondary">
                          {item.warrantyDays ? `${item.warrantyDays}d` : '---'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[10px] font-black text-primary whitespace-nowrap">{formatMoney(item.price)}</div>
                      <div className="text-[8px] text-emerald-600 dark:text-emerald-400 font-black whitespace-nowrap">GAN: {formatMoney(item.margin)}</div>
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
                            const { totalStock, isLowStock, levels, ...productOnly } = item as any;
                            openStockManager(productOnly);
                          }}
                          className="text-muted hover:text-emerald-600 transition-colors p-1.5 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-950/50 border border-base shadow-sm"
                          title="Gestionar Stock"
                        >
                          <PackagePlus className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => {
                            const { totalStock, isLowStock, levels, ...productOnly } = item as any;
                            setEditingProduct(productOnly);
                            setFormData(productOnly);
                            setShowAddModal(true);
                          }}
                          className="text-muted hover:text-indigo-600 transition-colors p-1.5 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-950/50 border border-base shadow-sm"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => window.confirm("¿Eliminar este producto permanentemente?\n\nSe eliminará del inventario y catálogo. Los registros históricos que no dependan del producto se conservarán cuando sea posible.") && deleteProduct(item.id)}
                          className="text-muted hover:text-rose-600 transition-colors p-1.5 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/50 border border-base shadow-sm"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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
                    const { totalStock, isLowStock, levels, ...productOnly } = item as any;
                    setEditingProduct(productOnly);
                    setFormData(productOnly);
                    setShowAddModal(true);
                  }}
                  className="bg-primary p-2.5 rounded-2xl border border-base shadow-xs hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer group flex flex-col gap-1.5 h-fit relative"
                >
                  <div className="flex justify-between items-start gap-1">
                    <h3 className="text-[10px] font-black text-primary uppercase tracking-tight line-clamp-2 leading-tight flex-1">{item.name}</h3>
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0 mt-0.5",
                      item.totalStock === 0 ? "bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.5)]" :
                      item.isLowStock ? "bg-amber-500" : "bg-emerald-500"
                    )} />
                  </div>
                  
                  <div className="flex items-center justify-between mt-auto">
                    <p className="text-[9px] font-black text-indigo-600">{formatMoney(item.price)}</p>
                    <p className={cn(
                      "text-[9px] font-black px-1.5 py-0.5 rounded-lg",
                      item.isLowStock ? "bg-rose-50/50 text-rose-600" : "bg-emerald-50/50 text-emerald-600"
                    )}>{item.totalStock}</p>
                  </div>

                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      const { totalStock, isLowStock, levels, ...productOnly } = item as any;
                      openStockManager(productOnly);
                    }}
                    className="absolute -top-1 -right-1 p-1 bg-white border border-base rounded-lg text-slate-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <PackagePlus className="w-3 h-3" />
                  </button>
                </div>
              ))}
              
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
        <div className="fixed inset-x-0 z-50 flex justify-center p-2"
          style={{ top: 0, height: '100dvh', maxHeight: '100dvh', paddingTop: 'max(0.5rem, env(safe-area-inset-top))', paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
          <div className="absolute inset-0 bg-slate-900/75 backdrop-blur-[2px]" aria-hidden="true" />
          <div className="team-employee-modal inventory-product-modal relative z-10 bg-secondary border border-base rounded-[22px] shadow-2xl overflow-hidden flex flex-col min-h-0"
            style={{
              maxHeight: 'calc(var(--palmyra-vv-height, 100dvh) - 1rem)',
              transform: 'translateY(var(--palmyra-vv-top, 0px))'
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
                          <input value={newSize} onChange={e=>setNewSize(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const value=newSize.trim();if(!value)return;setFormData(prev=>({...prev,availableSizes:Array.from(new Set([...(prev.availableSizes||[]),value]))}));setNewSize('');}}} className="inventory-product-input" placeholder="Ej. M, 40, 42" />
                          <button type="button" onClick={()=>{const value=newSize.trim();if(!value)return;setFormData(prev=>({...prev,availableSizes:Array.from(new Set([...(prev.availableSizes||[]),value]))}));setNewSize('');}} className="inventory-product-small-button">Agregar</button>
                        </div>
                        <div className="inventory-variant-tags">{(formData.availableSizes||[]).map(size=><button type="button" key={size} onClick={()=>setFormData(prev=>({...prev,availableSizes:(prev.availableSizes||[]).filter(x=>x!==size)}))} className="inventory-variant-tag inventory-variant-tag-indigo">{size}<span>×</span></button>)}</div>
                      </div>
                      <div className="inventory-variant-group">
                        <div className="inventory-variant-head"><label className="inventory-product-label">Colores</label><span>{(formData.availableColors || []).length}</span></div>
                        <div className="inventory-product-action-row">
                          <input value={newColor} onChange={e=>setNewColor(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const value=newColor.trim();if(!value)return;setFormData(prev=>({...prev,availableColors:Array.from(new Set([...(prev.availableColors||[]),value]))}));setNewColor('');}}} className="inventory-product-input" placeholder="Ej. Negro, Rojo" />
                          <button type="button" onClick={()=>{const value=newColor.trim();if(!value)return;setFormData(prev=>({...prev,availableColors:Array.from(new Set([...(prev.availableColors||[]),value]))}));setNewColor('');}} className="inventory-product-small-button">Agregar</button>
                        </div>
                        <div className="inventory-variant-tags">{(formData.availableColors||[]).map(color=><button type="button" key={color} onClick={()=>setFormData(prev=>({...prev,availableColors:(prev.availableColors||[]).filter(x=>x!==color)}))} className="inventory-variant-tag inventory-variant-tag-violet">{color}<span>×</span></button>)}</div>
                      </div>
                    </div>
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
                          <div className="inventory-product-field"><label className="inventory-product-label">Costo compra · CUP</label><input type="number" required value={formData.costPrice===0?'':(formData.costPrice??'')} placeholder="0.00" onFocus={e=>e.target.select()} onChange={e=>handleCostPriceChange(e.target.value===''?0:(parseFloat(e.target.value)||0),formData.price||0)} className="inventory-product-input" /></div>
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
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-50 flex justify-center items-center p-3 sm:p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 duration-200 overflow-hidden max-h-[90vh]">
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
            
            <div className="p-4 overflow-y-auto custom-scrollbar flex-1 bg-white dark:bg-slate-900">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {branches.map(branch => {
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
                    <div key={branch.id} className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700/60 space-y-2.5 flex flex-col justify-between">
                      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-200 dark:border-slate-700/60">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Building2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                          <p className="text-xs font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight truncate">{getBranchDisplayName(branch)}</p>
                        </div>
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 shrink-0 border border-indigo-200/50 dark:border-indigo-800/50">
                          {totalInBranch} uds
                        </span>
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
                Almacenes: <strong className="text-slate-900 dark:text-slate-100 font-bold">{branches.length}</strong>
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
                        <button type="button" onClick={()=>window.confirm("¿Eliminar categoría?")&&deleteCategory(cat.id)} title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
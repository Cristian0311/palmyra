import React, { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, X, Filter, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { useStore } from "../store/useStore";
import { Product } from "../types";
import { normalizeSemanticText } from "../utils/textUtils";
import { VoiceCommandButton } from "./VoiceCommandButton";
import { matchVoiceProducts, parseVoiceCommand } from "../utils/voiceCommands";
import { getDevicePerformanceTier } from "../utils/devicePerformance";

type POSCatalogProps = {
  baseCurrencySymbol: string;
  currentUserRole?: string;
  showMobileCart: boolean;
  onSelectConfiguredProduct: (product: Product) => void;
  onOutOfStock: () => void;
};

export const POSCatalog = React.memo(function POSCatalog({
  baseCurrencySymbol,
  currentUserRole,
  showMobileCart,
  onSelectConfiguredProduct,
  onOutOfStock,
}: POSCatalogProps) {
  const { categories, products, inventory, cart, currentBranchId, addToCart, updateCartQty } = useStore(useShallow((state) => ({
    categories: state.categories,
    products: state.products,
    inventory: state.inventory,
    cart: state.cart,
    currentBranchId: state.currentBranchId,
    addToCart: state.addToCart,
    updateCartQty: state.updateCartQty
  })));
  const performanceTier = getDevicePerformanceTier();
  const ultraLowMemory = performanceTier === "ultra";
  const [activeCategoryId, setActiveCategoryId] = useState("Todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const currentBranchStockMap = useMemo(() => {
    const map = new Map<string, number>();
    (inventory || []).forEach(i => {
      if (i.branchId !== currentBranchId) return;
      const key = i.variantLabel ? `${i.productId}::${i.variantLabel}` : i.productId;
      map.set(i.productId, (map.get(i.productId) || 0) + i.quantity);
      if (i.variantLabel) map.set(key, i.quantity);
    });
    return map;
  }, [inventory, currentBranchId]);

  const productSearchIndex = useMemo(() => {
    const index = new Map<string, { product: Product; name: string; sku: string; barcode: string; id: string }>();
    for (const product of products || []) {
      if (!product?.id) continue;
      index.set(product.id, {
        product,
        name: normalizeSemanticText(product.name),
        sku: normalizeSemanticText(product.sku),
        barcode: normalizeSemanticText(product.barcode),
        id: normalizeSemanticText(product.id),
      });
    }
    return index;
  }, [products]);

  const filteredProducts = useMemo(() => {
    const query = normalizeSemanticText(debouncedSearchQuery);
    const filtered = Array.from(productSearchIndex.values()).filter(entry => {
      const p = entry.product;
      if (!p) return false;
      const normName = entry.name;
      const normSku = entry.sku;
      const normBarcode = entry.barcode;
      const normId = entry.id;
      const isCodeMatch = !!query && (
        normSku === query || normBarcode === query || normId === query ||
        (query.length >= 3 && (normSku.includes(query) || normBarcode.includes(query)))
      );
      if (isCodeMatch) return true;
      if (query && !(normName.includes(query) || normSku.includes(query) || normBarcode.includes(query))) return false;
      if (activeCategoryId !== "Todos" && p.categoryId !== activeCategoryId) return false;
      if (query) return true;
      return (currentBranchStockMap.get(p.id) || 0) > 0;
    });
    const uniqueMap = new Map<string, Product>();
    filtered.forEach(entry => { const p = entry.product; if (p?.id && !uniqueMap.has(p.id)) uniqueMap.set(p.id, p); });
    return Array.from(uniqueMap.values()).sort((a, b) => (a.name || "").localeCompare(b.name || "")).slice(0, 80);
  }, [productSearchIndex, debouncedSearchQuery, activeCategoryId, currentBranchStockMap]);

  const getProductStock = (productId: string) => currentBranchStockMap.get(productId) || 0;

  const handleVoiceCommand = (spokenText: string) => {
    const command = parseVoiceCommand(spokenText);
    if (command.action === "search") {
      setSearchQuery(command.query);
      return;
    }
    if (command.action === "clear") {
      setSearchQuery("");
      return;
    }

    const matches = matchVoiceProducts(products || [], command.query, 5, command.price);
    if (!matches.length) {
      setSearchQuery(command.query);
      return;
    }

    const pricedMatches = command.price !== undefined
      ? matches.filter(product => Math.abs(Number(product.price) - command.price!) < 0.0001)
      : matches;
    const candidates = pricedMatches.length ? pricedMatches : matches;
    const first = candidates[0];
    const normalizedQuery = normalizeSemanticText(command.query);
    const exact = [first.name, first.sku, first.barcode, first.id]
      .map(value => normalizeSemanticText(value || ""))
      .includes(normalizedQuery);

    if (!exact && candidates.length > 1) {
      setSearchQuery(command.query);
      return;
    }

    const stock = getProductStock(first.id);
    if (stock <= 0) {
      onOutOfStock();
      return;
    }

    if (command.action === "add") {
      const needsConfig = first.hasSerial || !!first.availableSizes?.length || !!first.availableColors?.length;
      if (needsConfig) {
        onSelectConfiguredProduct(first);
        return;
      }
      const quantity = Math.min(command.quantity, stock);
      addToCart(first, undefined, undefined, quantity);
      return;
    }

    const cartMatch = cart.find(item => item.product?.id === first.id);
    if (cartMatch && (command.action === "remove" || command.action === "decrease" || command.action === "increase")) {
      const delta = command.action === "increase"
        ? command.quantity
        : -command.quantity;
      updateCartQty(cartMatch.id, delta);
      setSearchQuery("");
      return;
    }

    setSearchQuery(command.query);
  };

  const handleProductClick = (product: Product) => {
    if (getProductStock(product.id) <= 0) {
      onOutOfStock();
      return;
    }
    const needsConfig = product.hasSerial || !!product.availableSizes?.length || !!product.availableColors?.length;
    if (needsConfig) onSelectConfiguredProduct(product);
    else addToCart(product);
  };

  const formatMoney = (amount: number) => {
    const isCup = ["CUP", "MN", "CUC", "₱"].includes(baseCurrencySymbol);
    const decimals = isCup ? 0 : 2;
    return `${baseCurrencySymbol} ${amount.toLocaleString("es-CU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  };

  return (
    <main className={cn(
      "flex-1 flex flex-col min-h-0 bg-white shadow-xs overflow-hidden",
      showMobileCart ? "hidden md:flex" : "flex"
    )}>

{/* Header Sub-bar: Search & Categories */}
<div className="p-3 sm:p-4 border-b border-slate-200/80 bg-white sticky top-0 z-30 shadow-sm">
  <div className="flex flex-col sm:flex-row items-center gap-3">
    {/* Category Selector First */}
    <div className="w-full sm:w-64 relative group">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 group-focus-within:text-indigo-500 transition-colors">
        <Filter className="w-3.5 h-3.5" />
      </div>
      <select 
        value={activeCategoryId}
        onChange={(e) => setActiveCategoryId(e.target.value)}
        className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[9px] font-black uppercase tracking-[0.06em] outline-none focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all appearance-none cursor-pointer shadow-sm"
      >
        <option value="Todos">Todas las Categorías</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
        <ChevronDown className="w-3.5 h-3.5" />
      </div>
    </div>
    
    {/* Search Bar - Main Focus */}
    <div className="relative flex-1 w-full">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
      <input 
        type="text" 
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Busca productos por nombre, SKU o código de barras..." 
        className="w-full pl-11 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-colors text-[9px] font-bold text-slate-900 placeholder:text-slate-400 shadow-sm"
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => setSearchQuery("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 transition-all"
          title="Limpiar búsqueda"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  </div>
</div>

    <div className="px-3 pb-2 flex items-center justify-end gap-2">
      <span className="text-[10px] font-bold text-slate-400">Di: “agrega 15 tenis”</span>
      <VoiceCommandButton onCommand={handleVoiceCommand} />
    </div>

{/* Product Grid */}
<div className="flex-1 overflow-y-auto p-2 sm:p-3 lg:p-4 bg-primary">
  <div className="pos-product-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2 pb-24 md:pb-6">
    {filteredProducts.map(product => {
      const stock = getProductStock(product.id);
      return (
        <button
          key={product.id}
          onClick={() => handleProductClick(product)}
          className="pos-product-card flex flex-col p-2 rounded-xl border border-base hover:border-indigo-500 hover:shadow-md transition-all active:scale-[0.98] bg-secondary relative overflow-hidden group shadow-2xs text-left"
        >
          {/* Stock Indicator - Hidden for workers */}
          {currentUserRole === 'admin' && (
            <div className="absolute top-1.5 left-1.5 z-20">
              <span className={cn(
                "text-[8px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-tight shadow-2xs border",
                stock > 5 ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800" : stock > 0 ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800" : "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800"
              )}>
                {stock} u.
              </span>
            </div>
          )}

          {(product.warrantyDays ?? 0) > 0 && (
            <div className="absolute top-1.5 right-1.5 bg-indigo-600 text-white text-[7px] font-black px-1.5 py-0.5 rounded-md shadow-2xs z-20 uppercase tracking-tight">
              {product.warrantyDays}d Gda
            </div>
          )}

          <div className="w-full h-24 sm:h-28 bg-subtle rounded-lg mb-1.5 flex items-center justify-center overflow-hidden relative border border-base">
            {product.image && !ultraLowMemory ? (
              <img 
                src={product.image} 
                alt={product?.name || "Producto"} 
                className="pos-product-image w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" 
                referrerPolicy="no-referrer" 
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = '';
                  e.currentTarget.style.display = 'none';
                }}
               loading="lazy" decoding="async" />
            ) : (
              <div className={cn("w-full h-full opacity-20 flex items-center justify-center font-black text-muted text-lg", product.color)}>
                {(product?.name || "PR").substring(0, 2).toUpperCase()}
              </div>
            )}
          </div>

          <div className="w-full space-y-1">
            <p className="font-bold text-primary text-[9px] leading-tight line-clamp-2 h-[2.2em]">{product?.name || "Producto"}</p>
            <div className="flex items-center justify-between pt-1 border-t border-base">
              <span className="text-[8px] font-mono text-muted uppercase truncate max-w-[45%]">{product.sku || 'S/SKU'}</span>
              <span className="text-indigo-600 dark:text-indigo-400 font-black text-[9px] sm:text-[10px]">
                {formatMoney(product.price)}
              </span>
            </div>
          </div>
        </button>
      );
    })}
  </div>
</div>
        
    </main>
  );
});

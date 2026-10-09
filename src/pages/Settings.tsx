import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Settings as SettingsIcon, Save, DollarSign, Building2, Users, Plus, Trash2, Edit, LayoutGrid, Store, AlertTriangle, RefreshCw, Usb, Bluetooth, Wifi, Printer, CheckCircle2, ExternalLink, AlertCircle, Sparkles, ChevronRight, Package, Search, X, Database, CreditCard, CloudUpload, CloudDownload, Check, Sun, Moon, Type, Palette } from "lucide-react";
import { useStore } from "../store/useStore";
import { InfoTooltip } from "../components/InfoTooltip";
import { SettingsWarehousesSection } from "../components/settings/SettingsWarehousesSection";
import { SettingsCategoriesSection } from "../components/settings/SettingsCategoriesSection";
import { Branch, Category } from "../types";
import { cn } from "../lib/utils";
import { normalizeSemanticText } from "../utils/textUtils";
import { connectBluetoothPrinter, connectPrinter, printESCPOS, isInsideIframe, isThermalPrinterAutoConnectEnabled, setThermalPrinterAutoConnect } from "../lib/escpos";
import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "../services/saas";
import { canUsePlanFeature } from "../services/planAccess";
import PlanFeatureGate from "../components/PlanFeatureGate";

export default function Settings() {
  const navigate = useNavigate();
  const { 
    currencies, updateCurrencyRate, 
    storeConfig, updateStoreConfig, 
    branches, addBranch, updateBranch, deleteBranch,
    categories, addCategory, updateCategory, deleteCategory,
    receiptConfig, updateReceiptConfig,
    users, currentUser,
    getBaseCurrency, clearAllData,
    exportData, importData,
    products,
    inventory, transactions, cashSessions,
    syncWithSupabase,
    addNotification
  } = useStore(useShallow((state) => ({ 
    currencies: state.currencies, 
    updateCurrencyRate: state.updateCurrencyRate, 
    storeConfig: state.storeConfig, 
    updateStoreConfig: state.updateStoreConfig, 
    branches: state.branches, 
    addBranch: state.addBranch, 
    updateBranch: state.updateBranch, 
    deleteBranch: state.deleteBranch, 
    categories: state.categories, 
    addCategory: state.addCategory, 
    updateCategory: state.updateCategory, 
    deleteCategory: state.deleteCategory, 
    receiptConfig: state.receiptConfig, 
    updateReceiptConfig: state.updateReceiptConfig, 
    users: state.users, 
    updateUser: state.updateUser,
    currentUser: state.currentUser, 
    addUser: state.addUser, 
    deleteUser: state.deleteUser, 
    getBaseCurrency: state.getBaseCurrency, 
    clearAllData: state.clearAllData, 
    exportData: state.exportData, 
    importData: state.importData, 
    registerEmployee: state.registerEmployee, 
    products: state.products, 
    inventory: state.inventory, 
    transactions: state.transactions, 
    cashSessions: state.cashSessions, 
    syncWithSupabase: state.syncWithSupabase,
    addNotification: state.addNotification
  })));

  const baseCurrency = getBaseCurrency();
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);

  const [rates, setRates] = useState<{ [code: string]: number }>(
    currencies.reduce((acc, c) => ({ ...acc, [c.code]: c.rateToBase }), {})
  );
  const [ratesDirty, setRatesDirty] = useState(false);
  const [isSavingRates, setIsSavingRates] = useState(false);

  // El catálogo remoto puede hidratarse después del primer render. Mantén la
  // edición del usuario, pero actualiza el formulario cuando llegan tasas nuevas.
  useEffect(() => {
    if (ratesDirty) return;
    setRates(currencies.reduce((acc, currency) => ({
      ...acc,
      [currency.code]: currency.rateToBase
    }), {} as { [code: string]: number }));
  }, [currencies, ratesDirty]);

  const [config, setConfig] = useState(storeConfig);
  const [ticketConfig, setTicketConfig] = useState(receiptConfig);
  useEffect(() => {
    setTicketConfig(receiptConfig);
  }, [receiptConfig]);
  
  const [autoConnectPrinter, setAutoConnectPrinter] = useState(() => isThermalPrinterAutoConnectEnabled());

  const [printerStatus, setPrinterStatus] = useState<{
    type: 'idle' | 'loading' | 'success' | 'error' | 'warning';
    message: string;
    deviceName?: string;
  } | null>(null);
  const [isInIframe, setIsInIframe] = useState(false);

  // In-app Toast
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  // In-app Deletion Confirmations (Bypasses iframe blocked window.confirm)
  const [branchToDelete, setBranchToDelete] = useState<{ id: string; name: string } | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  const [newBranchName, setNewBranchName] = useState("");
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [warehousePlanLimit, setWarehousePlanLimit] = useState<number | null>(null);
  const [warehousePlanName, setWarehousePlanName] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadSaaSContext(true)
      .then((ctx) => {
        if (cancelled) return;
        const rawLimit = Number(ctx?.subscription?.limits?.warehouses);
        setWarehousePlanLimit(Number.isFinite(rawLimit) ? rawLimit : null);
        setWarehousePlanName(ctx?.subscription?.planName || "");
      })
      .catch(() => {
        // The cached SaaS context in the store remains the local fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  const [newCategory, setNewCategory] = useState({ name: "", department: "" });
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  

  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showConfirmCache, setShowConfirmCache] = useState(false);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const RESET_OPTIONS = [
    { id: 'inventory', label: 'Inventario', desc: 'Existencias, movimientos y transferencias', icon: Package },
    { id: 'reports', label: 'Reportes e historial', desc: 'Ventas, turnos, devoluciones, garantías y auditorías', icon: Database },
    { id: 'catalog', label: 'Productos', desc: 'Productos y categorías', icon: LayoutGrid },
    { id: 'customers', label: 'Clientes', desc: 'Clientes registrados', icon: Users },
    { id: 'suppliers', label: 'Proveedores', desc: 'Proveedores registrados', icon: Store },
    { id: 'purchases', label: 'Compras', desc: 'Pedidos a proveedores', icon: CloudDownload },
    { id: 'cash', label: 'Caja y turnos', desc: 'Turnos, movimientos de caja y liquidaciones', icon: DollarSign },
    { id: 'bank', label: 'Bancos', desc: 'Tarjetas y movimientos bancarios', icon: CreditCard },
    { id: 'users', label: 'Usuarios y empleados', desc: 'Restablece usuarios dejando el administrador inicial', icon: Users },
    { id: 'branches', label: 'Almacenes', desc: 'Elimina los almacenes configurados', icon: Building2 },
    { id: 'quotes', label: 'Cotizaciones y pedidos', desc: 'Cotizaciones y pedidos pendientes', icon: CloudUpload },
    { id: 'settings', label: 'Configuración', desc: 'Tasas de moneda y valores de configuración restablecibles', icon: SettingsIcon },
  ] as const;
  const [resetSections, setResetSections] = useState<string[]>([]);

  const settingsContentRef = useRef<HTMLDivElement | null>(null);

  const [activeTab, setActiveTab] = useState<'connectivity' | 'company' | 'currency' | 'branches' | 'categories' | 'ticket' | 'visual' | 'advanced'>('connectivity');
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [fontScale, setFontScale] = useState(() => { try { const saved = Number(localStorage.getItem('palmyra-font-scale') || '1'); return [0.9,1,1.1,1.2].includes(saved) ? saved : 1; } catch { return 1; } });
  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => {
      if (active) setPlanCode(ctx?.subscription?.planCode || null);
    }).catch(() => { if (active) setPlanCode(null); });
    return () => { active = false; };
  }, [currentUser?.id]);
  const visualStyleLocked = planCode !== null && !canUsePlanFeature(planCode, "visual_style");
  useEffect(() => { document.documentElement.style.setProperty('--palmyra-font-scale', String(fontScale)); try { localStorage.setItem('palmyra-font-scale', String(fontScale)); } catch {} }, [fontScale]);
  useEffect(() => {
    settingsContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activeTab]);

  const handleClearData = async () => {
    if (resetInput.trim().toUpperCase() !== 'ELIMINAR' || resetSections.length === 0) return;
    setIsLoading(true);
    try {
      const result = await useStore.getState().resetSelectedData(resetSections as any);
      if (!result.success) {
        showToast(`Restablecimiento parcial. No se pudieron limpiar: ${result.failed.join(', ')}`, 'error');
        return;
      }
      showToast('Los módulos seleccionados fueron restablecidos correctamente.');
      setShowConfirmReset(false);
      setResetInput('');
      setResetSections([]);
      window.location.reload();
    } catch (e) {
      console.error('Error al restablecer los datos:', e);
      showToast('No se pudo completar el restablecimiento.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleResetSection = (id: string) => {
    setResetSections(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleAllResetSections = () => {
    setResetSections(prev => prev.length === RESET_OPTIONS.length ? [] : RESET_OPTIONS.map(x => x.id));
  };

  useEffect(() => {
    setConfig(storeConfig);
  }, [storeConfig]);

  const handleAddBranch = () => {
    const name = newBranchName.trim();
    if (!name) return showToast("Escribe el nombre del almacén.", "error");
    if (editingBranch) {
      updateBranch(editingBranch.id, { name });
      setEditingBranch(null);
      setNewBranchName("");
      showToast("Almacén actualizado correctamente.");
      return;
    }
    addBranch({ id: crypto.randomUUID(), name, isActive: true });
    setNewBranchName("");
    showToast("Almacén guardado correctamente.");
  };

  const handleAddCategory = () => {
    const name = newCategory.name.trim();
    const department = newCategory.department.trim();
    if (!name) return showToast("Escribe el nombre de la categoría.", "error");
    if (editingCategory) {
      updateCategory(editingCategory.id, { name, department });
      setEditingCategory(null);
      setNewCategory({ name: "", department: "" });
      showToast("Categoría actualizada correctamente.");
      return;
    }
    addCategory({ id: crypto.randomUUID(), name, department });
    setNewCategory({ name: "", department: "" });
    showToast("Categoría guardada correctamente.");
  };

  const confirmDeleteBranch = () => {
    if (!branchToDelete) return;
    deleteBranch(branchToDelete.id);
    setBranchToDelete(null);
    showToast("Almacén eliminado correctamente.");
  };

  const confirmDeleteCategory = () => {
    if (!categoryToDelete) return;
    deleteCategory(categoryToDelete.id);
    setCategoryToDelete(null);
    showToast("Categoría eliminada correctamente.");
  };

  const handleSaveRates = async () => {
    const baseCode = currencies.find(currency => currency.isBase)?.code || baseCurrency.code;
    const editableCurrencies = currencies.filter(currency =>
      ['CUP', 'USD', 'EUR'].includes(currency.code) &&
      currency.code !== baseCode &&
      !currency.isBase
    );

    const invalidCurrency = editableCurrencies.find(currency => {
      const rate = Number(rates[currency.code]);
      return !Number.isFinite(rate) || rate <= 0;
    });
    if (invalidCurrency) {
      showToast(`Introduce una tasa mayor que 0 para ${invalidCurrency.code}.`, 'error');
      return;
    }

    setIsSavingRates(true);
    try {
      const results = await Promise.all(editableCurrencies.map(currency =>
        updateCurrencyRate(currency.code, Number(rates[currency.code]))
      ));
      const latestCurrencies = useStore.getState().currencies || [];
      setRates(latestCurrencies.reduce((acc, currency) => ({
        ...acc,
        [currency.code]: currency.rateToBase
      }), {} as { [code: string]: number }));
      setRatesDirty(false);

      if (results.every(Boolean)) {
        showToast("Tasas de cambio guardadas y confirmadas por Supabase.");
      } else {
        showToast("Tasas guardadas en este dispositivo; una o más no se confirmaron en Supabase y quedan pendientes de revisión/sincronización.", 'info');
      }
    } catch (error) {
      console.error('[Settings] No se pudieron guardar todas las tasas:', error);
      showToast("No se pudo confirmar el guardado remoto. Los valores locales se conservaron; revisa la conexión y vuelve a intentarlo.", 'error');
    } finally {
      setIsSavingRates(false);
    }
  };

  const handleSaveConfig = async () => {
    const companyName = config.storeName.trim();
    if (!companyName) {
      showToast("El nombre de la empresa no puede quedar vacío.", "error");
      return;
    }

    updateStoreConfig({ ...config, storeName: companyName });

    // El nombre SaaS canónico vive en companies.name. Solo lo sincronizamos
    // desde la pestaña Empresa, evitando que otros ajustes sobrescriban identidad.
    try {
      const supabase = getSupabase();
      const ctx = await import("../services/saas").then(m => m.loadSaaSContext());
      if (!supabase || !ctx?.companyId) throw new Error("No hay una empresa activa.");
      const { error } = await supabase
        .from("companies")
        .update({ name: companyName })
        .eq("id", ctx.companyId);
      if (error) throw error;
      showToast("Datos de la empresa actualizados.");
    } catch (error: any) {
      showToast("Se guardó la configuración local, pero no se pudo actualizar el nombre SaaS.", "error");
      addNotification("No se pudo sincronizar el nombre de la empresa.", "error", error?.message || "Error de Supabase.");
    }
  };

  const handleSaveTicket = () => {
    updateReceiptConfig(ticketConfig);
    showToast("Configuración de ticket guardada.");
  };

  const handleClearAppCache = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.update?.();
      showToast("Caché de la aplicación limpiada. Los datos offline no fueron borrados.");
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      console.error("[PALMYRA] No se pudo limpiar el caché de aplicación:", error);
      showToast("No se pudo limpiar el caché de la aplicación.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleManualSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    let syncRes: Awaited<ReturnType<typeof import('../services/offlineSync').processOfflineQueue>> | null = null;
    try {
      const { processOfflineQueue } = await import('../services/offlineSync');
      const { getOfflineQueueCount } = await import('../services/offlineQueue');
      const count = getOfflineQueueCount();
      if (count > 0) {
        addNotification(`Sincronizando ${count} operaciones pendientes...`, 'info');
        syncRes = await processOfflineQueue();
        if (syncRes.processed) addNotification(`Cola procesada: ${syncRes.processed} operaciones.`, 'success');
        if (syncRes.failed) addNotification(`Error en ${syncRes.failed} operaciones.`, 'error');
      }
      const cloudResult = await syncWithSupabase();
      const remaining = getOfflineQueueCount();
      if (remaining > 0 || cloudResult?.success === false) {
        addNotification(`Sincronización incompleta: quedan ${remaining} operaciones pendientes.`, "warning", [
          ...(syncRes?.errors || []).map((e: any) => `${e.type} · ${e.actionId}: ${e.message}`),
          ...(cloudResult?.errors || []).map((e: string) => `Nube: ${e}`),
          cloudResult?.success === false && cloudResult?.message ? `Nube: ${cloudResult.message}` : ''
        ].filter(Boolean).join('\n') || 'No se recibió un detalle específico. Revisa el registro de sincronización.');
      } else {
        showToast("Sincronización completa con Supabase.");
      }
    } catch (e) {
      addNotification("Error al sincronizar con la nube.", "error", "La sincronización lanzó una excepción antes de completar el proceso. Revisa la conexión y vuelve a intentarlo.");
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div data-palmi-content="settings" className="settings-page space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 w-full min-w-0 max-w-5xl mx-auto pb-8 relative overflow-x-hidden">
      {/* In-App Toast Notification */}
      {toast && (
        <div className="fixed top-2 right-2 sm:top-4 sm:right-4 z-[200] w-[calc(100vw-1rem)] sm:w-auto max-w-md min-w-0 animate-in slide-in-from-top-4 fade-in duration-300">
          <div className={cn(
            "p-4 rounded-2xl shadow-2xl border flex items-center gap-3 backdrop-blur-md",
            toast.type === 'success' ? "bg-emerald-950/95 text-emerald-100 border-emerald-800/80 shadow-emerald-900/30" :
            toast.type === 'error' ? "bg-rose-950/95 text-rose-100 border-rose-800/80 shadow-rose-900/30" :
            "bg-slate-900/95 text-white border-slate-700 shadow-slate-900/30"
          )}>
            {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
            {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
            {toast.type === 'info' && <Database className="w-5 h-5 text-rose-400 shrink-0" />}
            <div className="flex-1 text-xs font-bold leading-snug">{toast.message}</div>
            <button onClick={() => setToast(null)} className="p-1 hover:bg-white/10 rounded-lg transition-colors">
              <X className="w-4 h-4 text-slate-400 hover:text-white" />
            </button>
          </div>
        </div>
      )}

      {/* Header and Sync Status */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-secondary p-4 rounded-3xl border border-base shadow-sm">
          <div>
            <h2 className="text-xl font-black text-primary uppercase tracking-tight flex items-center gap-2">
              <SettingsIcon size={20} className="text-rose-600" />
              Configuración
            </h2>
            <p className="text-[10px] font-bold text-muted uppercase tracking-widest">Sistema y Preferencias</p>
          </div>
          <button
            onClick={handleManualSync}
            disabled={isSyncing || !navigator.onLine}
            className={cn(
              "w-full sm:w-auto px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50",
              isSyncing ? "bg-slate-100 text-slate-400" : "bg-rose-600 text-white hover:bg-rose-700 shadow-rose-600/20"
            )}
          >
            {isSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload size={14} />}
            {isSyncing ? "Sincronizando..." : "Sincronizar Nube"}
          </button>
        </div>

        {/* Linear Tabs for Sections */}
        <div className="flex items-center gap-1 bg-secondary p-1 rounded-xl border border-base shrink-0 w-full overflow-x-auto custom-scrollbar shadow-xs scroll-smooth">
          {/* Las acciones críticas de backup, restauración, caché y borrado global están aisladas en Avanzado. */}
          {[
            { id: 'connectivity', label: 'Conexión', icon: Wifi },
            { id: 'company', label: 'Empresa', icon: Store },
            { id: 'currency', label: 'Monedas', icon: DollarSign },
            { id: 'branches', label: 'Almacenes', icon: Building2 },
            { id: 'categories', label: 'Categorías', icon: LayoutGrid },
            { id: 'ticket', label: 'Impresora térmica', icon: Printer },
            { id: 'visual', label: 'Estilo visual', icon: Palette },
            { id: 'advanced', label: 'Avanzado', icon: AlertTriangle },
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id as any)} 
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer",
                  isActive 
                    ? "bg-rose-600 text-white shadow-xs" 
                    : "text-secondary hover:text-primary hover:bg-subtle"
                )}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-violet-50/70 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-900/40 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">Gestión de trabajadores</p>
          <h3 className="mt-1 text-sm font-black text-primary">Todo el equipo se administra desde una sola vista</h3>
          <p className="mt-1 text-[10px] leading-4 text-secondary">Crear empleados, enviar invitaciones, asignar roles, permisos, salarios y almacenes ahora vive en <strong>Equipo</strong>.</p>
        </div>
        <button type="button" onClick={() => navigate("/team")} className="shrink-0 w-full sm:w-auto h-10 px-4 rounded-xl bg-violet-600 text-white text-[10px] font-black uppercase tracking-wider shadow-sm hover:bg-violet-700 transition-colors">Abrir Equipo</button>
      </div>

      <div ref={settingsContentRef} id="settings-section-content" className="grid grid-cols-1 gap-3 min-w-0 scroll-mt-2">
        {/* Conectividad y Sincronización */}
        {activeTab === 'connectivity' && (
          <div className="space-y-4">
            <div className="bg-secondary rounded-2xl shadow-sm border border-rose-200 dark:border-rose-900/30 p-5 space-y-4">
              <div className="flex items-center gap-3 border-b border-rose-50 dark:border-rose-950/30 pb-3">
                <div className="bg-rose-50 dark:bg-rose-950/50 p-2 rounded-lg text-rose-600 dark:text-rose-400">
                  <Wifi size={16} />
                </div>
                <div>
                  <h3 className="text-xs font-black text-rose-600 dark:text-rose-400 uppercase tracking-wider">Conectividad y Nube</h3>
                  <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Control de guardado offline y transferencia de datos</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <label className="flex items-center justify-between p-3.5 bg-primary border border-base rounded-2xl cursor-pointer group hover:border-rose-300 transition-all">
                    <div className="flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <CloudUpload size={14} className="text-rose-600" />
                        <span className="text-[11px] font-black text-primary uppercase">Sincronización Manual</span>
                      </div>
                      <p className="text-[9px] text-muted font-medium mt-1 leading-tight">
                        Si se activa, el sistema NO subirá los datos automáticamente al recuperar internet. Deberás presionar "Sincronizar Nube" manualmente para evitar errores por caídas de conexión.
                      </p>
                    </div>
                    <div className="relative inline-flex items-center">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={config.manualOfflineSync === true}
                        onChange={e => {
                          const newConfig = { ...config, manualOfflineSync: e.target.checked };
                          setConfig(newConfig);
                          updateStoreConfig(newConfig);
                          showToast(`Sincronización manual ${e.target.checked ? 'activada' : 'desactivada'}.`, 'info');
                        }}
                      />
                      <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-600"></div>
                    </div>
                  </label>

               <div className="bg-amber-50/50 dark:bg-amber-950/10 p-3.5 rounded-2xl border border-amber-100 dark:border-amber-900/30 flex items-start gap-3">
                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-[9px] text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
                      <strong>Recomendación:</strong> Activa el modo manual en zonas con internet inestable. El sistema guardará todo en una cola local protegida y solo subirá cuando tú lo decidas, garantizando la integridad de cada transacción.
                    </p>
                  </div>
                </div>

                <div className="bg-primary p-4 rounded-2xl border border-base border-dashed flex flex-col justify-between">
                  <div>
                    <h4 className="text-[10px] font-black text-primary uppercase flex items-center gap-2">
                      <Database size={14} className="text-rose-600" />
                      Estado de la Base de Datos
                    </h4>
                    <div className="grid grid-cols-2 gap-3 mt-4">
                      <div className="p-3 bg-secondary rounded-xl border border-base">
                        <p className="text-[8px] font-black text-muted uppercase">Productos</p>
                        <p className="text-base font-black text-primary">{products.length}</p>
                      </div>
                      <div className="p-3 bg-secondary rounded-xl border border-base">
                        <p className="text-[8px] font-black text-muted uppercase">Ventas</p>
                        <p className="text-base font-black text-primary">{transactions.length}</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-[8px] text-muted uppercase tracking-wider text-center mt-4 font-bold">
                    Conectado a Supabase: <span className="text-emerald-500">{navigator.onLine ? 'SÍ' : 'NO (OFFLINE)'}</span>
                  </p>
                </div>
              </div>
            </div>


          </div>
        )}

        {/* Datos de la Empresa */}
        {activeTab === 'company' && (
          <div className="space-y-3 min-w-0">
            <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4 min-w-0">
              <div className="flex items-center gap-3 border-b border-base pb-3">
                <div className="bg-rose-50 dark:bg-rose-950/50 p-2 rounded-lg text-rose-600 dark:text-rose-400 shrink-0">
                  <Store size={16} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-xs font-black text-primary uppercase tracking-wider">Datos de la Empresa</h3>
                  <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Nombre, teléfono y dirección usados por PALMYRA</p>
                </div>
              </div>

              <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/60 dark:bg-indigo-950/20 p-3 flex items-start gap-3">
              <input type="checkbox" checked={autoConnectPrinter} onChange={e => { setAutoConnectPrinter(e.target.checked); setThermalPrinterAutoConnect(e.target.checked); }} className="mt-0.5 h-4 w-4 accent-indigo-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-wider text-indigo-800 dark:text-indigo-200">Conectar automáticamente la impresora</p>
                <p className="mt-0.5 text-[9px] leading-4 font-semibold text-indigo-700/80 dark:text-indigo-300/80">PALMYRA intentará reconectar la última impresora autorizada al abrir la web o la PWA.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1.5 min-w-0">
                  <span className="text-[10px] font-black text-muted uppercase px-1">Nombre del Negocio</span>
                  <input type="text" value={config.storeName}
                    onChange={e => setConfig({ ...config, storeName: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 shadow-sm" />
                </label>
                <label className="space-y-1.5 min-w-0">
                  <span className="text-[10px] font-black text-muted uppercase px-1">Teléfono</span>
                  <input type="text" value={config.phone}
                    onChange={e => setConfig({ ...config, phone: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 shadow-sm" />
                </label>
                <label className="space-y-1.5 md:col-span-2 min-w-0">
                  <span className="text-[10px] font-black text-muted uppercase px-1">Dirección</span>
                  <input type="text" value={config.address}
                    onChange={e => setConfig({ ...config, address: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 shadow-sm" />
                </label>
              </div>

              <div className="pt-1 flex justify-end">
                <button onClick={handleSaveConfig}
                  className="w-full sm:w-auto px-5 py-2.5 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer">
                  <Save size={14} /> Guardar Cambios
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Monedas y tasas */}
        {activeTab === 'currency' && (
          <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-3 border-b border-base pb-3">
              <div className="bg-emerald-50 dark:bg-emerald-950/30 p-2 rounded-lg text-emerald-600 dark:text-emerald-400 shrink-0">
                <DollarSign size={16} />
              </div>
              <div className="min-w-0">
                <h3 className="text-xs font-black text-primary uppercase tracking-wider">Monedas y tasas</h3>
                <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Configura las tasas usadas por ventas, caja y reportes</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              {currencies.filter(currency => ['CUP', 'USD', 'EUR'].includes(currency.code)).map(currency => {
                const isBase = currency.code === baseCurrency.code;
                return (
                  <div key={currency.code} className={cn("min-w-0 px-3 py-2.5 rounded-xl border flex items-center justify-between gap-3", isBase ? "bg-subtle border-base" : "bg-primary border-base")}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-6 h-6 rounded-md bg-secondary text-primary font-black text-[11px] flex items-center justify-center shrink-0 border border-base">{currency.symbol || (currency.code === 'EUR' ? '€' : '$')}</span>
                      <span className="text-xs font-black text-primary uppercase">{currency.code}</span>
                    </div>
                    {isBase ? (
                      <span className="shrink-0 text-[9px] font-black uppercase text-emerald-600">1.00 (Base)</span>
                    ) : (
                      <div className="flex items-center min-w-0 bg-subtle border border-base rounded-lg px-2 py-0.5">
                        <span className="hidden sm:inline text-[9px] font-black text-muted mr-1 whitespace-nowrap">1 {currency.code} =</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          inputMode="decimal"
                          aria-label={`Tasa de cambio de ${currency.code} a ${baseCurrency.code}`}
                          value={rates[currency.code] ?? ''}
                          onChange={e => {
                            setRates({ ...rates, [currency.code]: e.target.value === '' ? 0 : Number(e.target.value) });
                            setRatesDirty(true);
                          }}
                          className="w-24 max-w-full min-w-0 bg-transparent text-right text-sm font-black text-primary outline-none border-0 shadow-none"
                        />
                        <span className="text-[9px] font-black text-muted ml-1">CUP</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleSaveRates}
              disabled={isSavingRates}
              className="w-full py-2.5 bg-emerald-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-wait transition-all flex items-center justify-center gap-2"
            >
              <Save size={14} /> {isSavingRates ? 'Guardando tasas…' : 'Guardar Tasas'}
            </button>
          </div>
        )}

        {/* Estilo visual */}
        {activeTab === 'visual' && visualStyleLocked && (
          <PlanFeatureGate feature="visual_style" title="Estilo visual del software" description="Personaliza la experiencia visual de PALMYRA y adapta la lectura de la interfaz a tu equipo. Disponible desde Caravana." />
        )}

        {activeTab === 'visual' && !visualStyleLocked && (
          <div className="space-y-4">
            <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-5">
              <div className="flex items-center gap-3 border-b border-base pb-3">
                <div className="bg-violet-100 dark:bg-violet-950/40 p-2.5 rounded-xl text-violet-700 dark:text-violet-300"><Palette size={18} /></div>
                <div><h3 className="text-xs font-black text-primary uppercase tracking-wider">Estilo visual del software</h3><p className="text-[9px] font-bold text-muted uppercase tracking-tight">Personaliza la lectura sin cambiar la estructura de PALMYRA</p></div>
              </div>
              <div className="p-4 rounded-2xl border border-base bg-subtle">
                <div className="flex items-start gap-3">
                  <Type className="w-5 h-5 text-violet-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h4 className="text-sm font-black text-primary">Tamaño de las letras</h4>
                    <p className="text-xs text-muted mt-1">El cambio se aplica inmediatamente a toda la interfaz y se conserva en este dispositivo.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                      {[
                        {value:0.9,label:'Pequeña',sample:'Aa'},
                        {value:1,label:'Normal',sample:'Aa'},
                        {value:1.1,label:'Grande',sample:'Aa'},
                        {value:1.2,label:'Muy grande',sample:'Aa'}
                      ].map(option => (
                        <button key={option.value} type="button" onClick={() => setFontScale(option.value)}
                          className={cn("rounded-xl border p-3 text-left transition-all", fontScale === option.value ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30 ring-2 ring-violet-500/15" : "border-base bg-primary hover:bg-subtle")}>
                          <span className="block text-lg font-black text-primary" style={{fontSize: (18 * option.value) + 'px'}}>{option.sample}</span>
                          <span className="block text-[10px] font-black text-primary mt-1">{option.label}</span>
                          <span className="block text-[9px] text-muted">{Math.round(option.value*100)}%</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="p-4 rounded-2xl border border-base bg-primary flex items-center justify-between gap-4">
                <div><h4 className="text-xs font-black text-primary">Vista recomendada</h4><p className="text-[10px] text-muted mt-1">Normal es el tamaño equilibrado para POS, tablets y escritorio.</p></div>
                <button type="button" onClick={() => setFontScale(1)} className="px-4 py-2 rounded-xl bg-violet-600 text-white text-[10px] font-black uppercase">Restablecer</button>
              </div>
            </div>
          </div>
        )}

        <SettingsWarehousesSection
          active={activeTab === 'branches'}
          branches={branches}
          editingBranch={editingBranch}
          newBranchName={newBranchName}
          setEditingBranch={setEditingBranch}
          setNewBranchName={setNewBranchName}
          setBranchToDelete={setBranchToDelete}
          onAddBranch={handleAddBranch}
          warehouseLimit={warehousePlanLimit}
          warehousePlanName={warehousePlanName}
        />

        <SettingsCategoriesSection
          active={activeTab === 'categories'}
          categories={categories}
          editingCategory={editingCategory}
          newCategory={newCategory}
          setEditingCategory={setEditingCategory}
          setNewCategory={setNewCategory}
          setCategoryToDelete={setCategoryToDelete}
          onAddCategory={handleAddCategory}
        />

        {activeTab === 'ticket' && (
          <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-3 border-b border-base pb-3">
              <div className="bg-indigo-50 dark:bg-indigo-950/30 p-2 rounded-lg text-indigo-600 dark:text-indigo-400"><Printer size={16} /></div>
              <div><h3 className="text-xs font-black text-primary uppercase tracking-wider">Impresora térmica</h3><p className="text-[8px] font-bold text-muted uppercase tracking-tight">Configuración que queda guardada por empresa</p></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 dark:bg-indigo-950/20 dark:border-indigo-900/40 p-3 cursor-pointer md:col-span-2">
                <div className="min-w-0">
                  <span className="block text-[10px] font-black text-indigo-900 dark:text-indigo-100 uppercase">Siempre conectarse automáticamente</span>
                  <span className="block text-[8px] font-semibold text-indigo-700/80 dark:text-indigo-300/80 mt-0.5">Al abrir PALMYRA o la PWA intentará reconectar la última impresora autorizada.</span>
                </div>
                <input type="checkbox" checked={autoConnectPrinter} onChange={e => { setAutoConnectPrinter(e.target.checked); setThermalPrinterAutoConnect(e.target.checked); }} className="h-4 w-4 accent-indigo-600 shrink-0" />
              </label>
              {[['showLogo','Mostrar logo'],['showAddress','Mostrar dirección'],['showPhone','Mostrar teléfono'],['showFooter','Mostrar pie del ticket'],['autoPrint','Imprimir automáticamente']].map(([key,label]) => (
                <label key={key} className="flex items-center justify-between gap-3 rounded-xl border border-base bg-primary p-3 cursor-pointer">
                  <span className="text-[10px] font-black text-primary uppercase">{label}</span>
                  <input type="checkbox" checked={Boolean((ticketConfig as any)[key])} onChange={e => setTicketConfig(prev => ({ ...prev, [key]: e.target.checked }))} className="h-4 w-4 accent-indigo-600" />
                </label>
              ))}
              <label className="space-y-1.5"><span className="text-[10px] font-black text-muted uppercase">Ancho</span><select value={ticketConfig.printerWidth || '80mm'} onChange={e => setTicketConfig(prev => ({ ...prev, printerWidth: e.target.value as '58mm' | '80mm' }))} className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary"><option value="58mm">58 mm</option><option value="80mm">80 mm</option></select></label>
              <label className="space-y-1.5 md:col-span-2"><span className="text-[10px] font-black text-muted uppercase">Texto del pie</span><textarea value={ticketConfig.footerText || ''} onChange={e => setTicketConfig(prev => ({ ...prev, footerText: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary resize-y" /></label>
            </div>
            <div className="flex justify-end"><button type="button" onClick={handleSaveTicket} className="w-full sm:w-auto px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"><Save size={14}/> Guardar configuración de ticket</button></div>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4">
            <div className="flex items-center gap-3 border-b border-base pb-3"><div className="bg-amber-50 dark:bg-amber-950/30 p-2 rounded-lg text-amber-600"><AlertTriangle size={16}/></div><div><h3 className="text-xs font-black text-primary uppercase tracking-wider">Herramientas avanzadas</h3><p className="text-[8px] font-bold text-muted uppercase tracking-tight">Respaldo, caché, sincronización y restablecimiento selectivo</p></div></div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button type="button" onClick={() => { const data = exportData(); const blob = new Blob([data], {type:'application/json'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='palmyra-respaldo.json'; a.click(); URL.revokeObjectURL(url); showToast('Respaldo exportado correctamente.'); }} className="h-11 rounded-xl border border-base bg-primary text-primary text-[10px] font-black uppercase flex items-center justify-center gap-2"><CloudDownload size={15}/> Exportar respaldo</button>
              <button type="button" onClick={handleClearAppCache} disabled={isLoading} className="h-11 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-900/40 text-[10px] font-black uppercase flex items-center justify-center gap-2 disabled:opacity-50"><RefreshCw size={15}/> Borrar caché</button>
              <button type="button" onClick={() => setShowConfirmReset(true)} className="h-11 rounded-xl bg-rose-600 text-white text-[10px] font-black uppercase flex items-center justify-center gap-2"><Trash2 size={15}/> Restablecer datos</button>
            </div>
            <div className="rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20 p-3 text-[9px] font-semibold text-amber-800 dark:text-amber-300">El restablecimiento es selectivo. No modifica la cuenta SaaS, el plan ni la autenticación.</div>
            {showConfirmReset && (
              <div className="rounded-2xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/60 dark:bg-rose-950/20 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-black uppercase text-rose-700 dark:text-rose-300">Selecciona qué restablecer</p><button type="button" onClick={toggleAllResetSections} className="text-[8px] font-black uppercase text-rose-600">{resetSections.length === RESET_OPTIONS.length ? 'Quitar todo' : 'Seleccionar todo'}</button></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{RESET_OPTIONS.map(option => { const Icon=option.icon; const checked=resetSections.includes(option.id); return <label key={option.id} className={cn('flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer',checked?'border-rose-400 bg-white dark:bg-slate-900':'border-base bg-primary')}><input type="checkbox" checked={checked} onChange={()=>toggleResetSection(option.id)} className="mt-0.5 accent-rose-600"/><Icon size={13} className="text-rose-600 mt-0.5 shrink-0"/><span><span className="block text-[9px] font-black text-primary uppercase">{option.label}</span><span className="block text-[8px] text-muted mt-0.5">{option.desc}</span></span></label>; })}</div>
                <input value={resetInput} onChange={e=>setResetInput(e.target.value)} placeholder="Escribe ELIMINAR para confirmar" className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-xs font-bold text-primary"/>
                <div className="flex gap-2"><button type="button" onClick={()=>{setShowConfirmReset(false);setResetInput('');setResetSections([])}} className="flex-1 h-10 rounded-xl border border-base text-[9px] font-black uppercase">Cancelar</button><button type="button" disabled={resetInput.trim().toUpperCase()!=='ELIMINAR'||resetSections.length===0||isLoading} onClick={handleClearData} className="flex-1 h-10 rounded-xl bg-rose-600 text-white text-[9px] font-black uppercase disabled:opacity-40">{isLoading?'Procesando…':'Confirmar'}</button></div>
              </div>
            )}
          </div>
        )}

        {(branchToDelete || categoryToDelete) && (
          <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-slate-950/50 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 border border-base shadow-2xl p-5">
              <div className="flex items-center gap-3"><AlertTriangle className="w-5 h-5 text-rose-600"/><h3 className="text-sm font-black text-primary">Confirmar eliminación</h3></div>
              <p className="mt-3 text-xs text-secondary">¿Seguro que deseas eliminar <strong>{branchToDelete?.name || categoryToDelete?.name}</strong>? Los registros históricos no se borrarán.</p>
              <div className="mt-5 flex gap-2"><button type="button" onClick={() => { setBranchToDelete(null); setCategoryToDelete(null); }} className="flex-1 h-10 rounded-xl border border-base text-xs font-black">Cancelar</button><button type="button" onClick={() => branchToDelete ? confirmDeleteBranch() : confirmDeleteCategory()} className="flex-1 h-10 rounded-xl bg-rose-600 text-white text-xs font-black">Eliminar</button></div>
            </div>
          </div>
        )}


      </div>


    </div>
  );
}

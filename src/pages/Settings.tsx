import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Settings as SettingsIcon, Save, DollarSign, Building2, Users, Plus, Trash2, Edit, LayoutGrid, Store, AlertTriangle, RefreshCw, Usb, Bluetooth, Wifi, Printer, CheckCircle2, ExternalLink, AlertCircle, Sparkles, ChevronRight, Package, Search, X, Database, CreditCard, CloudUpload, CloudDownload, Check, Sun, Moon, Type, Palette } from "lucide-react";
import { useStore } from "../store/useStore";
import { InfoTooltip } from "../components/InfoTooltip";
import { SettingsWarehousesSection } from "../components/settings/SettingsWarehousesSection";
import { SettingsCategoriesSection } from "../components/settings/SettingsCategoriesSection";
import { SettingsEmployeeConfigModal } from "../components/settings/SettingsEmployeeConfigModal";
import { Branch, Category, User } from "../types";
import { cn } from "../lib/utils";
import { normalizeSemanticText } from "../utils/textUtils";
import { connectBluetoothPrinter, connectPrinter, printESCPOS, isInsideIframe } from "../lib/escpos";
import { getSupabase } from "../lib/supabase";

export default function Settings() {
  const navigate = useNavigate();
  const { 
    currencies, updateCurrencyRate, 
    storeConfig, updateStoreConfig, 
    branches, addBranch, updateBranch, deleteBranch,
    categories, addCategory, updateCategory, deleteCategory,
    receiptConfig, updateReceiptConfig,
    users, updateUser, addUser, deleteUser,
    getBaseCurrency, clearAllData,
    exportData, importData,
    registerEmployee,
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
  const employees = useMemo(() => users.filter(user => user.role === 'employee'), [users]);

  const [rates, setRates] = useState<{ [code: string]: number }>(
    currencies.reduce((acc, c) => ({ ...acc, [c.code]: c.rateToBase }), {})
  );

  const [config, setConfig] = useState(storeConfig);
  const [ticketConfig, setTicketConfig] = useState(receiptConfig);
  useEffect(() => {
    setTicketConfig(receiptConfig);
  }, [receiptConfig]);
  const [employeeSalaries, setEmployeeSalaries] = useState<{ [id: string]: number }>({});
  
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
  const [userToDelete, setUserToDelete] = useState<{ id: string; name: string } | null>(null);
  const [branchToDelete, setBranchToDelete] = useState<{ id: string; name: string } | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  // Sync employee salaries when users are loaded
  useEffect(() => {
    if (users.length > 0) {
      setEmployeeSalaries(prev => {
        const next = { ...prev };
        users.forEach(u => {
          if (!(u.id in next)) {
            next[u.id] = u.baseSalary || 0;
          }
        });
        return next;
      });
    }
  }, [users]);

  const [newBranchName, setNewBranchName] = useState("");
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);

  const [newCategory, setNewCategory] = useState({ name: "", department: "" });
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  
  const [newEmployee, setNewEmployee] = useState({ name: "", password: "" });

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

  const [selectedUserForConfig, setSelectedUserForConfig] = useState<User | null>(null);
  const settingsContentRef = useRef<HTMLDivElement | null>(null);

  const [activeTab, setActiveTab] = useState<'connectivity' | 'company' | 'currency' | 'branches' | 'categories' | 'employees' | 'visual' | 'advanced'>('connectivity');
  const [fontScale, setFontScale] = useState(() => { try { const saved = Number(localStorage.getItem('palmyra-font-scale') || '1'); return [0.9,1,1.1,1.2].includes(saved) ? saved : 1; } catch { return 1; } });
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

  const handleSaveRates = () => {
    Object.entries(rates).forEach(([code, rate]) => {
      updateCurrencyRate(code, rate as number);
    });
    showToast("Tasas de cambio actualizadas correctamente.");
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

  const handleSaveEmployeeSalary = (userId: string) => {
    const salary = employeeSalaries[userId];
    updateUser(userId, { baseSalary: salary });
    showToast("Salario actualizado correctamente.");
  };

  const confirmDeleteUserAction = () => {
    if (userToDelete) {
      deleteUser(userToDelete.id);
      showToast(`Empleado "${userToDelete.name}" desactivado. Se conserva su historial.`);
      setUserToDelete(null);
    }
  };

  const confirmDeleteBranchAction = () => {
    if (branchToDelete) {
      const hasStock = (inventory || []).some(l => l.branchId === branchToDelete.id && l.quantity > 0);
      const hasTx = (transactions || []).some(t => t.branchId === branchToDelete.id && !t.deletedAt);
      const hasSessions = (cashSessions || []).some(s => s.branchId === branchToDelete.id && !s.deletedAt);

      if (hasStock || hasTx || hasSessions) {
        showToast(`No se puede eliminar "${branchToDelete.name}" porque contiene existencias, ventas o turnos registrados. Considere desactivarla.`, "error");
        setBranchToDelete(null);
        return;
      }

      deleteBranch(branchToDelete.id);
      showToast(`Almacén "${branchToDelete.name}" eliminado.`);
      setBranchToDelete(null);
    }
  };

  const confirmDeleteCategoryAction = () => {
    if (categoryToDelete) {
      const hasProducts = (products || []).some(p => p.categoryId === categoryToDelete.id);
      if (hasProducts) {
        showToast(`No se puede eliminar la categoría "${categoryToDelete.name}" porque tiene productos asignados.`, "error");
        setCategoryToDelete(null);
        return;
      }

      deleteCategory(categoryToDelete.id);
      showToast(`Categoría "${categoryToDelete.name}" eliminada.`);
      setCategoryToDelete(null);
    }
  };

  const handleAddBranch = () => {
    const trimmed = newBranchName.trim();
    if (trimmed) {
      const normInput = normalizeSemanticText(trimmed);
      const duplicate = branches.find(b => 
        normalizeSemanticText(b.name) === normInput && 
        (!editingBranch || b.id !== editingBranch.id)
      );

      if (duplicate) {
        showToast(`Ya existe un almacén con este nombre ("${duplicate.name}"). No se permiten duplicados.`, "error");
        return;
      }

      if (editingBranch) {
        updateBranch(editingBranch.id, { name: trimmed });
        setEditingBranch(null);
        showToast("Almacén actualizado.");
      } else {
        addBranch({ id: crypto.randomUUID(), name: trimmed });
        showToast("Almacén agregado y guardado en Supabase.");
      }
      setNewBranchName("");
    }
  };

  const handleAddCategory = () => {
    if (newCategory.name.trim() && newCategory.department.trim()) {
      if (editingCategory) {
        updateCategory(editingCategory.id, { name: newCategory.name.trim(), department: newCategory.department.trim() });
        setEditingCategory(null);
        showToast("Categoría actualizada.");
      } else {
        addCategory({ id: crypto.randomUUID(), name: newCategory.name.trim(), department: newCategory.department.trim() });
        showToast("Categoría registrada.");
      }
      setNewCategory({ name: "", department: "" });
    }
  };

  const handleRegisterEmployeeManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmployee.name.trim() || !newEmployee.password) return;
    registerEmployee(newEmployee.name.trim(), newEmployee.password);
    setNewEmployee({ name: "", password: "" });
    showToast("Empleado registrado con éxito. Ya aparecerá en el punto de venta.");
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
    <div className="settings-page space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 w-full min-w-0 max-w-5xl mx-auto pb-8 relative overflow-x-hidden">
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
                        <input type="number" step="0.01" min="0" value={rates[currency.code] ?? ''}
                          onChange={e => setRates({ ...rates, [currency.code]: parseFloat(e.target.value) || 0 })}
                          className="w-16 bg-transparent text-right text-xs font-black text-primary outline-none border-0 shadow-none" />
                        <span className="text-[9px] font-black text-muted ml-1">CUP</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button onClick={handleSaveRates} className="w-full py-2.5 bg-emerald-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 transition-all flex items-center justify-center gap-2">
              <Save size={14} /> Guardar Tasas
            </button>
          </div>
        )}

        {/* Estilo visual */}
        {activeTab === 'visual' && (
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

        {/* Categorías */}
        {activeTab === 'categories' && (
          <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4" style={{ display: 'none' }}>
            <div className="flex items-center gap-3 border-b border-base pb-3">
              <div className="bg-amber-50 dark:bg-amber-950/30 p-2 rounded-lg text-amber-600 dark:text-amber-400">
                <LayoutGrid size={16} />
              </div>
              <div>
                <h3 className="text-xs font-black text-primary uppercase tracking-wider">Categorías de Productos</h3>
                <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Clasificación de inventario para reportes</p>
              </div>
            </div>
            {/* ... Categories content ... */}
          </div>
        )}

        {/* Empleados */}
        {activeTab === 'employees' && (
          <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4" style={{ display: 'none' }}>
            <div className="flex items-center gap-3 border-b border-base pb-3">
              <div className="bg-rose-50 dark:bg-rose-950/50 p-2 rounded-lg text-rose-600 dark:text-rose-400">
                <Users size={16} />
              </div>
              <div>
                <h3 className="text-xs font-black text-primary uppercase tracking-wider">Gestión de Empleados</h3>
                <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Permisos y salarios por turno</p>
              </div>
            </div>
            {/* ... Employees content ... */}
          </div>
        )}

      </div>

      {/* In-App User Deletion Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[150] flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
          <div className="palmyra-mobile-modal bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-5 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
                <Trash2 className="w-6 h-6" />
              </div>
              <h3 className="text-base font-black text-slate-900 uppercase">¿Desactivar Empleado?</h3>
              <p className="text-xs text-slate-600">
                ¿Desactivar a <span className="font-bold text-slate-900">{userToDelete.name}</span>? El empleado perderá acceso, pero se conservarán su historial y operaciones.
              </p>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setUserToDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteUserAction}
                className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/20 transition-all cursor-pointer"
              >
                Sí, Desactivar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Branch Deletion Confirmation Modal */}
      {branchToDelete && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-5 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
                <Store className="w-6 h-6" />
              </div>
              <h3 className="text-base font-black text-slate-900 uppercase">¿Eliminar almacén?</h3>
              <p className="text-xs text-slate-600">
                ¿Estás seguro de que deseas eliminar el almacén <span className="font-bold text-slate-900">"{branchToDelete.name}"</span>?
              </p>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBranchToDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteBranchAction}
                className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/20 transition-all cursor-pointer"
              >
                Sí, Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Category Deletion Confirmation Modal */}
      {categoryToDelete && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-5 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
                <Trash2 className="w-6 h-6" />
              </div>
              <h3 className="text-base font-black text-slate-900 uppercase">¿Eliminar Categoría?</h3>
              <p className="text-xs text-slate-600">
                ¿Estás seguro de que deseas eliminar la categoría <span className="font-bold text-slate-900">"{categoryToDelete.name}"</span>?
              </p>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCategoryToDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteCategoryAction}
                className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/20 transition-all cursor-pointer"
              >
                Sí, Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsEmployeeConfigModal
        user={selectedUserForConfig}
        branches={branches}
        employeeSalaries={employeeSalaries}
        setEmployeeSalaries={setEmployeeSalaries}
        setUser={setSelectedUserForConfig}
        updateUser={updateUser}
        setUserToDelete={setUserToDelete}
        onClose={() => setSelectedUserForConfig(null)}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Tasas de Cambio (Compacto Lineal: CUP, USD, EUR) */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 sm:p-5 space-y-3.5 min-w-0" style={{ display: 'none' }}>
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="bg-emerald-50 p-1.5 rounded-lg text-emerald-600 shrink-0">
                <DollarSign className="w-4 h-4" />
              </div>
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider truncate">Tasas de Cambio</h3>
            </div>
            <span className="text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md shrink-0">
              Base: CUP
            </span>
          </div>
          
          <div className="space-y-2">
            {currencies
              .filter(currency => ['CUP', 'USD', 'EUR'].includes(currency.code))
              .map(currency => {
                const isBase = currency.code === 'CUP';
                return (
                  <div 
                    key={currency.code} 
                    className={cn(
                      "px-3 py-2 rounded-xl border transition-all flex items-center justify-between gap-3",
                      isBase ? "bg-slate-50 border-slate-200" : "bg-white border-slate-200 hover:border-rose-300 shadow-xs"
                    )}
                  >
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="w-6 h-6 rounded-md bg-slate-100 text-slate-800 font-black text-[11px] flex items-center justify-center shrink-0 border border-slate-200 shadow-2xs">
                        {currency.symbol || (currency.code === 'EUR' ? '€' : '$')}
                      </span>
                      <span className="text-xs font-black text-slate-900 uppercase tracking-tight">
                        {currency.code}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 justify-end shrink-0">
                      {isBase ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-[9px] font-black uppercase tracking-wider">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          1.00 (Base)
                        </span>
                      ) : (
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-lg px-2 py-0.5 focus-within:ring-2 focus-within:ring-rose-500/20 focus-within:border-rose-500 transition-all">
                          <span className="text-[9px] font-black text-slate-400 mr-1 select-none">
                            1 {currency.code} =
                          </span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={rates[currency.code] ?? ''}
                            onChange={(e) => setRates({ ...rates, [currency.code]: parseFloat(e.target.value) || 0 })}
                            className="w-14 sm:w-16 bg-white border border-slate-200 rounded px-1.5 py-0.5 text-right text-xs font-black text-slate-900 outline-none focus:border-rose-500"
                            placeholder="0.00"
                          />
                          <span className="text-[9px] font-black text-slate-600 ml-1 select-none">
                            CUP
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          <button 
            onClick={handleSaveRates}
            className="w-full py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-md shadow-rose-100 active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Guardar Tasas
          </button>
        </div>

        <SettingsCategoriesSection
          active={activeTab === "categories"}
          categories={categories}
          editingCategory={editingCategory}
          newCategory={newCategory}
          setEditingCategory={setEditingCategory}
          setNewCategory={setNewCategory}
          setCategoryToDelete={setCategoryToDelete}
          onAddCategory={handleAddCategory}
        />

        <SettingsWarehousesSection
          active={activeTab === "branches"}
          branches={branches}
          editingBranch={editingBranch}
          newBranchName={newBranchName}
          setEditingBranch={setEditingBranch}
          setNewBranchName={setNewBranchName}
          setBranchToDelete={setBranchToDelete}
          onAddBranch={handleAddBranch}
        />

        {/* Apariencia y Visibilidad (Mejorado para Miopía) */}
        <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4 lg:col-span-3" style={{ display: activeTab === 'visual' ? undefined : 'none' }}>
          <div className="flex items-center gap-3 border-b border-base pb-3">
            <div className="bg-rose-600 p-2 rounded-lg text-white">
              <Sparkles size={16} />
            </div>
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider">Apariencia y Visibilidad</h3>
              <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Personalización del entorno de trabajo</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 bg-subtle p-6 rounded-2xl border border-base">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-3">
                <div className="bg-primary text-rose-600 p-2 rounded-xl shadow-sm border border-base">
                  {config.darkMode ? <Moon size={16} /> : <Sun size={16} />}
                </div>
                <div>
                  <h4 className="text-sm font-black text-primary uppercase tracking-tight">Experiencia Visual</h4>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="px-2 py-0.5 bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-[8px] font-black rounded-full uppercase tracking-wider border border-rose-200 dark:border-rose-800">
                      Enterprise Mode
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-secondary leading-relaxed max-w-xl">
                Personaliza el entorno de trabajo. El modo oscuro utiliza una paleta de grises profundos diseñada para reducir la fatiga visual.
              </p>
            </div>

            <div className="shrink-0 flex flex-col items-end gap-3">
              <div className="bg-secondary p-1.5 rounded-2xl border border-base shadow-sm flex items-center gap-1">
                <button 
                  onClick={() => {
                    const newConfig = { ...config, darkMode: false };
                    setConfig(newConfig);
                    updateStoreConfig(newConfig);
                    showToast("Modo luz activado");
                  }}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer",
                    !config.darkMode ? "bg-rose-600 text-white shadow-lg" : "text-muted hover:bg-subtle"
                  )}
                >
                  <Sun size={14} />
                  Luz
                </button>
                <button 
                  onClick={() => {
                    const newConfig = { ...config, darkMode: true };
                    setConfig(newConfig);
                    updateStoreConfig(newConfig);
                    showToast("Modo oscuro activado");
                  }}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer",
                    config.darkMode ? "bg-rose-600 text-white shadow-lg" : "text-muted hover:bg-subtle"
                  )}
                >
                  <Moon size={14} />
                  Oscuro
                </button>
              </div>
              <p className="text-[9px] font-bold text-muted uppercase tracking-widest px-2">Selección de Tema</p>
            </div>
          </div>
        </div>

        {/* Offline Backup & Restore Section */}
        <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4 lg:col-span-3" style={{ display: activeTab === 'advanced' ? undefined : 'none' }}>
          <div className="flex items-center gap-3 border-b border-base pb-3">
            <div className="bg-emerald-50 dark:bg-emerald-950/30 p-2.5 rounded-xl text-emerald-600 dark:text-emerald-400">
              <Save size={20} />
            </div>
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider">Avanzado · Copias y Restauración</h3>
              <p className="text-[9px] font-bold text-muted uppercase tracking-tight">Descarga tus datos en un archivo JSON para restaurarlos manualmente cuando quieras</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-base">
              <div className="flex items-center gap-2 mb-2">
                <CloudDownload className="w-4 h-4 text-rose-500" />
                <span className="text-[10px] font-black uppercase text-primary tracking-widest">Generar Backup</span>
              </div>
              <p className="text-[9px] text-muted mb-4 font-bold">Crea un archivo con toda tu información local: productos, ventas, turnos y configuración.</p>
              <button
                onClick={() => {
                  const data = exportData();
                  const blob = new Blob([data], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `backup_pos_${new Date().toISOString().split('T')[0]}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  showToast("Copia de seguridad generada y descargada", "success");
                }}
                className="w-full py-2.5 bg-rose-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all shadow-md active:scale-95"
              >
                Descargar Archivo JSON
              </button>
            </div>

            <div className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-base">
              <div className="flex items-center gap-2 mb-2">
                <CloudUpload className="w-4 h-4 text-emerald-500" />
                <span className="text-[10px] font-black uppercase text-primary tracking-widest">Restaurar Datos</span>
              </div>
              <p className="text-[9px] text-muted mb-4 font-bold">⚠️ ATENCIÓN: Al restaurar, se sobrescribirán todos los datos actuales por los del archivo.</p>
              
              <label className="block">
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  id="backup-upload"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;

                    if (window.confirm("¿Estás seguro de que deseas RESTAURAR los datos? Esta acción sobrescribirá TODO el sistema actual y sincronizará con la nube.")) {
                      setIsLoading(true);
                      const reader = new FileReader();
                      reader.onload = async (event) => {
                        const content = event.target?.result as string;
                        const result = await importData(content);
                        if (result.success) {
                          showToast("Sistema restaurado con éxito", "success");
                          setTimeout(() => window.location.reload(), 1500);
                        } else {
                          showToast(`Error: ${result.error}`, "error");
                        }
                        setIsLoading(false);
                      };
                      reader.readAsText(file);
                    }
                    e.target.value = ''; // Reset input
                  }}
                />
                <div 
                  onClick={() => document.getElementById('backup-upload')?.click()}
                  className="w-full py-2.5 bg-emerald-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-emerald-700 transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                  Cargar y Restaurar
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Configuración de Ticket / Recibo */}
        <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4 lg:col-span-3" style={{ display: activeTab === 'connectivity' ? undefined : 'none' }}>
          <div className="flex items-center gap-3 border-b border-base pb-3">
            <div className="bg-rose-50 dark:bg-rose-950/30 p-2 rounded-lg text-rose-600 dark:text-rose-400">
              <Plus size={16} />
            </div>
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider">Configuración de Ticket</h3>
              <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Información comercial en el recibo</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-4">
              <h4 className="text-[9px] font-black text-muted uppercase tracking-widest border-b border-base pb-1">Hardware e Impresión</h4>
              <div className="space-y-3">
                <label className="flex items-center justify-between cursor-pointer group">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-secondary group-hover:text-primary transition-colors uppercase">Impresión Automática</span>
                    <span className="text-[7px] text-muted font-medium uppercase">Sin confirmación previa</span>
                  </div>
                  <div className="relative inline-flex items-center ml-2">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={ticketConfig.autoPrint ?? false}
                      onChange={e => setTicketConfig({...ticketConfig, autoPrint: e.target.checked})}
                    />
                    <div className="w-8 h-4 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-rose-600"></div>
                  </div>
                </label>

                <label className="flex items-center justify-between cursor-pointer group">
                  <span className="text-[10px] font-bold text-secondary group-hover:text-primary transition-colors uppercase">Abrir Gaveta</span>
                  <div className="relative inline-flex items-center">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={ticketConfig.openDrawer ?? true}
                      onChange={e => setTicketConfig({...ticketConfig, openDrawer: e.target.checked})}
                    />
                    <div className="w-8 h-4 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-rose-600"></div>
                  </div>
                </label>
                
                <label className="flex items-center justify-between cursor-pointer group">
                  <div>
                    <span className="text-[10px] font-bold text-secondary group-hover:text-primary transition-colors block uppercase">Impresión Directa</span>
                    <span className="text-[7px] text-muted font-medium uppercase">Directo Bluetooth BLE / USB / Serie</span>
                  </div>
                  <div className="relative inline-flex items-center ml-2 shrink-0">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={ticketConfig.useWebSerial ?? false}
                      onChange={e => setTicketConfig({...ticketConfig, useWebSerial: e.target.checked})}
                    />
                    <div className="w-8 h-4 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-rose-600"></div>
                  </div>
                </label>

                {ticketConfig.useWebSerial && (
                  <div className="space-y-2.5 p-3.5 bg-subtle rounded-xl border border-base">
                    <div className="flex items-center justify-between">
                      <span className="block text-[8px] font-black text-muted uppercase tracking-widest">Buscar Impresora</span>
                      {isInIframe && (
                        <button
                          type="button"
                          onClick={() => window.open(window.location.href, '_blank')}
                          className="text-[8px] font-bold text-rose-600 hover:text-rose-800 flex items-center gap-1 bg-rose-50 dark:bg-rose-950/50 px-2 py-0.5 rounded transition-all cursor-pointer"
                        >
                          <ExternalLink size={10} />
                          Externo
                        </button>
                      )}
                    </div>
                    
                    {printerStatus && (
                      <div className={cn(
                        "p-2.5 rounded-lg text-[9px] font-medium leading-tight flex items-start gap-2 animate-in fade-in duration-200",
                        printerStatus.type === 'loading' && "bg-blue-50 border border-blue-200 text-blue-800 dark:bg-blue-950/20 dark:border-blue-800/50 dark:text-blue-200",
                        printerStatus.type === 'success' && "bg-emerald-50 border border-emerald-200 text-emerald-900 dark:bg-emerald-950/20 dark:border-emerald-800/50 dark:text-emerald-200",
                        printerStatus.type === 'error' && "bg-rose-50 border border-rose-200 text-rose-800 dark:bg-rose-950/20 dark:border-rose-800/50 dark:text-rose-200",
                        printerStatus.type === 'warning' && "bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/20 dark:border-amber-800/50 dark:text-amber-200",
                        printerStatus.type === 'idle' && "bg-subtle border border-base text-muted"
                      )}>
                        {printerStatus.type === 'loading' && <RefreshCw size={14} className="animate-spin shrink-0 mt-0.5" />}
                        {printerStatus.type === 'success' && <CheckCircle2 size={14} className="shrink-0 mt-0.5" />}
                        {printerStatus.type === 'error' && <AlertTriangle size={14} className="shrink-0 mt-0.5" />}
                        {printerStatus.type === 'warning' && <AlertCircle size={14} className="shrink-0 mt-0.5" />}
                        <div className="flex-1">
                          <p>{printerStatus.message}</p>
                          {printerStatus.deviceName && (
                            <p className="text-[8px] opacity-80 mt-0.5 font-bold uppercase">Dispositivo: {printerStatus.deviceName}</p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          setPrinterStatus({ type: 'loading', message: 'Buscando puertos USB...' });
                          try {
                            
                            if (isInsideIframe()) {
                              setPrinterStatus({
                                type: 'warning',
                                message: 'USB nativo bloqueado en el visor. Abre en pestaña externa.'
                              });
                              return;
                            }
                            await connectPrinter();
                            setPrinterStatus({
                              type: 'success',
                              message: 'USB conectado y listo.',
                              deviceName: 'Puerto Serie USB'
                            });
                          } catch (error: any) {
                            if (error.message?.includes('cancelada')) {
                              setPrinterStatus({ type: 'idle', message: 'Selección cancelada.' });
                              return;
                            }
                            setPrinterStatus({ type: 'error', message: error.message || 'Error USB' });
                          }
                        }}
                        className="py-2.5 px-3 bg-primary border border-base text-primary rounded-lg text-[9px] font-black uppercase tracking-wider hover:bg-subtle transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
                      >
                        <Usb size={14} className="text-rose-600" />
                        USB / Serie
                      </button>

                      <button
                        type="button"
                        onClick={async () => {
                          setPrinterStatus({ type: 'loading', message: 'Escaneando Bluetooth...' });
                          try {
                            
                            if (isInsideIframe()) {
                              setPrinterStatus({
                                type: 'warning',
                                message: 'Bluetooth bloqueado en el visor. Abre en pestaña externa.'
                              });
                              return;
                            }
                            const dev = await connectBluetoothPrinter();
                            setPrinterStatus({
                              type: 'success',
                              message: 'Bluetooth vinculado.',
                              deviceName: dev?.name || 'BT Printer'
                            });
                          } catch (error: any) {
                            if (error.message?.includes('cancelada')) {
                              setPrinterStatus({ type: 'idle', message: 'Cancelado.' });
                              return;
                            }
                            setPrinterStatus({ type: 'error', message: error.message || 'Error BT' });
                          }
                        }}
                        className="py-2.5 px-3 bg-primary border border-base text-primary rounded-lg text-[9px] font-black uppercase tracking-wider hover:bg-subtle transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
                      >
                        <Bluetooth size={14} className="text-blue-600" />
                        Bluetooth
                      </button>
                    </div>

                    <div className="space-y-1 pt-1">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            
                            const randomProducts = [...products].sort(() => 0.5 - Math.random()).slice(0, 2);
                            const productLines = randomProducts.map(p => `LEFT|${p.name.toUpperCase()} x1 ... $${p.price}`);
                            
                            const lines = [
                              "CENTER|BOLD|" + (ticketConfig.businessName || "MI NEGOCIO"),
                              "CENTER|" + (ticketConfig.businessAddress || "DIRECCIÓN DE PRUEBA"),
                              "CENTER|TEL: " + (ticketConfig.businessPhone || "000-000-0000"),
                              "---",
                              "CENTER|BOLD|TICKET DE PRUEBA",
                              "---",
                              ...productLines,
                              "---",
                              "CENTER|BOLD|TOTAL: $0.00",
                              "---",
                              "CENTER|" + (ticketConfig.footerText || "¡GRACIAS POR SU COMPRA!"),
                              "CENTER|VERSIÓN 2.0"
                            ];

                            await printESCPOS({
                              lines: lines,
                              width: ticketConfig.printerWidth || '58mm'
                            });
                          } catch (err: any) {
                            setPrinterStatus({ type: 'error', message: `Error: ${err.message}` });
                          }
                        }}
                        className="w-full py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-sm active:scale-95 cursor-pointer"
                      >
                        <Printer size={15} />
                        Ticket de Prueba
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Ancho de Papel</label>
                  <select 
                    value={ticketConfig.printerWidth || '58mm'}
                    onChange={e => setTicketConfig({...ticketConfig, printerWidth: e.target.value as '58mm' | '80mm'})}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 cursor-pointer"
                  >
                    <option value="58mm">58 mm (Pequeña)</option>
                    <option value="80mm">80 mm (Estándar)</option>
                  </select>
                </div>
              </div>
              
              <h4 className="text-[9px] font-black text-muted uppercase tracking-widest border-b border-base pb-1 mt-6">Visibilidad</h4>
              <div className="space-y-3">
                {[
                  { key: 'showLogo', label: 'Nombre / Logo' },
                  { key: 'showAddress', label: 'Dirección' },
                  { key: 'showPhone', label: 'Teléfono' },
                  { key: 'showFooter', label: 'Pie de Página' },
                ].map(item => (
                  <label key={item.key} className="flex items-center justify-between cursor-pointer group">
                    <span className="text-[10px] font-bold text-secondary group-hover:text-primary transition-colors uppercase">{item.label}</span>
                    <div className="relative inline-flex items-center">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={(ticketConfig as any)[item.key]}
                        onChange={e => setTicketConfig({...ticketConfig, [item.key]: e.target.checked})}
                      />
                      <div className="w-8 h-4 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-rose-600"></div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-4 col-span-1 md:col-span-2">
              <h4 className="text-[9px] font-black text-muted uppercase tracking-widest border-b border-base pb-1">Información Impresa</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest">Nombre Comercial</label>
                  <input type="text" value={ticketConfig.businessName} onChange={e => setTicketConfig({...ticketConfig, businessName: e.target.value})} className="w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 transition-all" />
                </div>
                <div className="space-y-1">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest">Teléfono</label>
                  <input type="text" value={ticketConfig.businessPhone} onChange={e => setTicketConfig({...ticketConfig, businessPhone: e.target.value})} className="w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 transition-all" />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest">Dirección</label>
                  <input type="text" value={ticketConfig.businessAddress} onChange={e => setTicketConfig({...ticketConfig, businessAddress: e.target.value})} className="w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 transition-all" />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest">Texto al Pie</label>
                  <textarea 
                    value={ticketConfig.footerText} 
                    onChange={e => setTicketConfig({...ticketConfig, footerText: e.target.value})}
                    rows={2}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 resize-none transition-all"
                    placeholder="Ej: ¡Gracias por su compra!"
                  ></textarea>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-base">
            <button 
              onClick={handleSaveTicket}
              className="w-full sm:w-auto px-8 py-3 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Save size={14} />
              Guardar Configuración
            </button>
          </div>
        </div>

      <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4 lg:col-span-3" style={{ display: activeTab === 'employees' ? undefined : 'none' }}>
        <div className="flex items-center justify-between gap-3 border-b border-base pb-3">
          <div className="flex items-center gap-3">
            <div className="bg-rose-50 dark:bg-rose-950/30 p-2 rounded-lg text-rose-600"><Users size={16} /></div>
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider">Gestión de Personal</h3>
              <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Empleados y permisos por almacén</p>
            </div>
          </div>
          <span className="text-[8px] font-black uppercase tracking-widest bg-rose-50 text-rose-600 px-2.5 py-1 rounded-full">Admin no cuenta en el límite</span>
        </div>

        <div className="bg-subtle p-4 rounded-xl border border-base border-dashed">
          <h4 className="text-[10px] font-black text-primary uppercase mb-3 flex items-center gap-2"><Plus size={14} className="text-rose-600" /> Registrar empleado</h4>
          <form onSubmit={handleRegisterEmployeeManual} className="grid gap-3 sm:grid-cols-3">
            <input type="text" placeholder="Nombre completo" required value={newEmployee.name} onChange={e => setNewEmployee({ ...newEmployee, name: e.target.value })}
              className="px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-rose-500" />
            <input type="password" placeholder="Contraseña inicial" required value={newEmployee.password} onChange={e => setNewEmployee({ ...newEmployee, password: e.target.value })}
              className="px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-rose-500" />
            <button type="submit" className="bg-rose-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-md flex items-center justify-center gap-2">
              <Plus size={14} /> Registrar
            </button>
          </form>
        </div>

        {users.length === 0 ? (
          <div className="p-8 bg-subtle rounded-xl text-center text-sm font-bold text-muted">No hay empleados registrados en este espacio.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {users.map(u => (
              <div key={u.id} className="p-4 rounded-2xl border border-base bg-secondary shadow-sm flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-primary uppercase truncate">{u.name}</p>
                    <span className="text-[7px] font-black uppercase bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full inline-flex mt-1">
                      {u.role === 'admin' ? 'Administrador' : 'Empleado'}
                    </span>
                  </div>
                  <button type="button" onClick={() => setUserToDelete({ id: u.id, name: u.name })} className="p-1.5 text-muted hover:text-rose-600 hover:bg-rose-50 rounded-lg" title="Desactivar empleado"><Trash2 size={14}/></button>
                </div>
                <div className="bg-subtle p-2.5 rounded-xl border border-base text-[9px] space-y-1.5">
                  <div className="flex justify-between font-bold text-muted"><span>Almacenes</span><span className="text-primary font-black">{(u.allowedBranches || branches.map(b => b.id)).length === branches.length ? 'Todos' : `${(u.allowedBranches || []).length} autorizados`}</span></div>
                  <div className="flex justify-between font-bold text-muted"><span>Salario base</span><span className="text-primary font-black">{baseCurrency.symbol}{(employeeSalaries[u.id] ?? u.baseSalary ?? 0).toLocaleString()}</span></div>
                </div>
                <button type="button" onClick={() => setSelectedUserForConfig(u)} className="w-full py-2 px-3 rounded-xl bg-rose-600 text-white font-black text-[9px] uppercase tracking-wider flex items-center justify-center gap-1.5">
                  <SettingsIcon size={14}/> Configuración
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/50 p-3 rounded-xl flex gap-3">
          <InfoTooltip text="Configura salarios y acceso por almacén. El administrador de la empresa no se cuenta dentro del límite de empleados del plan." />
          <p className="text-[9px] text-rose-700 dark:text-rose-300 font-medium leading-relaxed">Los límites de empleados se validan en el servidor antes de aceptar nuevos registros.</p>
        </div>
      </div>

      {/* Zona Peligrosa */}
      <div className="bg-secondary rounded-2xl shadow-sm border border-red-200 dark:border-red-900/30 p-5 space-y-4 lg:col-span-3" style={{ display: activeTab === 'advanced' ? undefined : 'none' }}>
        <div className="flex items-center gap-3 border-b border-red-50 dark:border-red-950/30 pb-3">
          <div className="bg-red-50 dark:bg-red-950/50 p-2 rounded-lg text-red-600 dark:text-red-400">
            <AlertTriangle size={16} />
          </div>
          <div>
            <h3 className="text-xs font-black text-red-600 dark:text-red-400 uppercase tracking-wider">Avanzado · Zona Peligrosa</h3>
            <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Acciones críticas e irreversibles</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-primary p-4 rounded-xl border border-base border-dashed">
          <div>
            <h4 className="text-sm font-bold text-primary">Limpiar caché del navegador</h4>
            <p className="text-xs text-muted mt-1">
              Limpia recursos temporales del navegador sin borrar ventas, inventario ni la información operativa guardada.
            </p>
          </div>
          <div className="flex gap-2">
            {showConfirmCache ? (
              <>
                <button
                  onClick={() => setShowConfirmCache(false)}
                  className="px-4 py-2 bg-subtle text-primary border border-base rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={async () => {
                    setIsLoading(true);
                    try {
                      // Cache reset must never touch localStorage or IndexedDB: those contain
                      // POS state and the durable offline queue. Only browser cache/SW/session
                      // state is removed here.
                      sessionStorage.clear();

                      if ('serviceWorker' in navigator) {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        await Promise.all(registrations.map(registration => registration.unregister()));
                      }

                      if ('caches' in window) {
                        const cacheNames = await caches.keys();
                        await Promise.all(cacheNames.map(name => caches.delete(name)));
                      }

                      setShowConfirmCache(false);
                      showToast('Caché, Service Worker y recursos temporales limpiados. Los datos operativos fueron conservados.');

                      // Give the browser one tick to finish unregister/delete operations, then
                      // force a fresh document request so an old controlled page cannot remain.
                      setTimeout(() => {
                        const url = new URL(window.location.href);
                        url.searchParams.set('_cache_reset', Date.now().toString());
                        window.location.replace(url.toString());
                      }, 100);
                    } catch (e) {
                      console.error('Error limpiando caché:', e);
                      showToast('No se pudo completar la limpieza de caché. Los datos operativos no fueron modificados.', 'error');
                    } finally {
                      setIsLoading(false);
                    }
                  }}
                  className="px-4 py-2 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-md active:scale-95"
                >
                  Confirmar
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowConfirmCache(true)}
                className="w-full sm:w-auto px-6 py-3 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw size={14} />
                Limpiar Caché
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-red-50/50 dark:bg-red-950/20 p-4 rounded-xl border border-red-100 dark:border-red-900/30">
          <div className="flex-1">
            <h4 className="text-sm font-bold text-primary">Restablecer Sistema</h4>
            <p className="text-xs text-muted mt-1">Selecciona exactamente qué módulos quieres restablecer. Los demás datos permanecen intactos.</p>
            {showConfirmReset && (
              <div className="mt-4 w-full p-4 bg-primary rounded-xl border border-red-200 dark:border-red-900/50">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <p className="text-xs font-black text-primary uppercase">¿Qué deseas restablecer?</p>
                    <p className="text-[10px] text-muted mt-1">Marca uno o varios módulos.</p>
                  </div>
                  <button type="button" onClick={toggleAllResetSections} className="px-3 py-2 text-[10px] font-black uppercase rounded-lg border border-base text-primary hover:bg-subtle">
                    {resetSections.length === RESET_OPTIONS.length ? 'Desmarcar todo' : 'Marcar todo'}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {RESET_OPTIONS.map(option => {
                    const Icon = option.icon;
                    const checked = resetSections.includes(option.id);
                    return (
                      <label key={option.id} className={cn('flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all', checked ? 'border-red-500 bg-red-50 dark:bg-red-950/20' : 'border-base hover:bg-subtle')}>
                        <input type="checkbox" checked={checked} onChange={() => toggleResetSection(option.id)} className="mt-1 h-4 w-4 accent-red-600" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-xs font-black text-primary"><Icon size={14} />{option.label}</span>
                          <span className="block text-[10px] text-muted mt-1 leading-snug">{option.desc}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50">
                  <p className="text-[10px] font-black text-red-700 dark:text-red-300 uppercase">Se borrará únicamente lo seleccionado</p>
                  <p className="text-[10px] text-muted mt-1">Esta acción no se puede deshacer. Antes de continuar, confirma escribiendo ELIMINAR.</p>
                </div>
                <input type="text" value={resetInput} onChange={e => setResetInput(e.target.value)} className="mt-3 w-full px-3 py-3 bg-secondary border border-base rounded-lg text-sm font-bold text-primary outline-none focus:ring-1 focus:ring-red-500 uppercase" placeholder="Escribe ELIMINAR" />
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {showConfirmReset ? (
              <>
                <button onClick={() => { setShowConfirmReset(false); setResetInput(''); setResetSections([]); }} className="px-4 py-2 bg-subtle text-primary border border-base rounded-xl text-[10px] font-black uppercase tracking-widest">Cancelar</button>
                <button onClick={handleClearData} disabled={isLoading || resetSections.length === 0 || resetInput.trim().toUpperCase() !== 'ELIMINAR'} className="px-4 py-2 bg-red-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-md disabled:opacity-30 flex items-center gap-2">
                  {isLoading ? <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" /> : <Trash2 size={12} />} Restablecer seleccionados
                </button>
              </>
            ) : (
              <button onClick={() => setShowConfirmReset(true)} disabled={isLoading} className="w-full sm:w-auto px-6 py-3 bg-red-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50">
                <Trash2 size={14} /> Restablecer datos
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

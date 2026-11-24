import { useShallow } from 'zustand/react/shallow';
import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Notifications from './Notifications';
import OperationsSurface from '../components/OperationsSurface';
import { canManageSettings, resolveSettingsSection, type SettingsSection } from '../utils/settingsAccess';
import { Settings as SettingsIcon, Save, DollarSign, Building2, Users, Trash2, LayoutGrid, Store, AlertTriangle, RefreshCw, Usb, Bluetooth, Wifi, Printer, CheckCircle2, AlertCircle, Package, X, Database, CreditCard, CloudUpload, CloudDownload, Type, Palette, Network, Bell, ClipboardCheck, ChevronDown, Link2 } from "lucide-react";
import { useStore } from "../store/useStore";
import { SettingsWarehousesSection } from "../components/settings/SettingsWarehousesSection";
import { SettingsCategoriesSection } from "../components/settings/SettingsCategoriesSection";
import { SettingsCurrencySection } from "../components/settings/SettingsCurrencySection";
import SettingsLanSection from "../components/settings/SettingsLanSection";
import { SettingsSectionHeader } from "../components/settings/SettingsSectionHeader";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import OfflineHealthSection from "../components/settings/OfflineHealthSection";
import DesktopDiagnostics from "../components/system/DesktopDiagnostics";
import LanPanel from "../components/system/LanPanel";
import BackupPanel from "../components/system/BackupPanel";
import AndroidBackupStatus from "../components/system/AndroidBackupStatus";
import AndroidDiagnostics from "../components/system/AndroidDiagnostics";
import InstallDiagnostics from "../components/system/InstallDiagnostics";
import RecoveryAssistant from "../components/system/RecoveryAssistant";
import RequestBudgetPanel from "../components/system/RequestBudgetPanel";
import GuidedMigrationPanel from "../components/system/GuidedMigrationPanel";
import PilotMetricsPanel from "../components/system/PilotMetricsPanel";
import PilotChecklist from "../components/system/PilotChecklist";
import { cloudRecoveryKeyStorageKey } from "../hooks/useCloudBackup";
import { createBackupResult } from "../services/localDb/backup";
import { getRuntimeDriver } from "../services/localDb/runtimeDriver";
import { getPalmyraLocalScope } from "../services/localScope";
import { PRODUCT_VERSION } from "../lib/productVersion";
import AndroidManualUpdate from "../components/system/AndroidManualUpdate";
import UpdateCenter from "../components/system/UpdateCenter";
import { Branch, Category } from "../types";
import { cn } from "../lib/utils";
import { runWithLoading } from "../lib/busy";
import { connectBluetoothPrinter, connectPrinter, getConnectedDeviceName, printESCPOS, isInsideIframe, isThermalPrinterAutoConnectEnabled, setThermalPrinterAutoConnect } from "../lib/escpos";
import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "../services/saas";
import { canUsePlanFeature } from "../services/planAccess";
import PlanFeatureGate from "../components/PlanFeatureGate";

const settingsTabs = [
  { id: 'company', label: 'Empresa', detail: 'Identidad y contacto', icon: Store },
  { id: 'branches', label: 'Almacenes', detail: 'Ubicaciones de inventario', icon: Building2 },
  { id: 'categories', label: 'Categorías', detail: 'Organización del catálogo', icon: LayoutGrid },
  { id: 'currency', label: 'Monedas y tasas', detail: 'Tasas manuales o automáticas', icon: DollarSign },
  { id: 'ticket', label: 'Impresora y comprobantes', detail: 'Conexión y formato de impresión', icon: Printer },
  { id: 'visual', label: 'Apariencia', detail: 'Tamaño del texto de la interfaz', icon: Palette },
  { id: 'lan', label: 'Red local', detail: 'Equipos conectados y nombres', icon: Network },
  { id: 'connectivity', label: 'Conexión y datos', detail: 'Estado local y sincronización', icon: Wifi },
  { id: 'notifications', label: 'Notificaciones', detail: 'Tus avisos y preferencias', icon: Bell },
  { id: 'piloto', label: 'Piloto', detail: 'Estado del negocio y puesta en marcha', icon: ClipboardCheck },
  { id: 'advanced', label: 'Administración avanzada', detail: 'Respaldos, actualizaciones y reparación', icon: AlertTriangle },
] satisfies { id: SettingsSection; label: string; detail: string; icon: typeof Bell }[];

const settingsGroups = [
  { id: 'business', label: 'Negocio', tabIds: ['company', 'branches', 'categories'] },
  { id: 'sales', label: 'Ventas y caja', tabIds: ['currency', 'ticket', 'visual'] },
  { id: 'system', label: 'Sistema', tabIds: ['lan', 'connectivity', 'notifications', 'piloto', 'advanced'] },
] satisfies { id: string; label: string; tabIds: SettingsSection[] }[];

export default function Settings() {
  const user = useStore(state => state.currentUser);
  const [params] = useSearchParams();
  const canManage = canManageSettings(user);
  const activeTab = resolveSettingsSection(user, params.get('section'));
  const tabs = settingsTabs.filter(tab => canManage || tab.id === 'notifications');
  const navGroups = settingsGroups
    .map(group => ({
      id: group.id,
      label: group.label,
      tabs: group.tabIds
        .map(id => tabs.find(tab => tab.id === id))
        .filter((tab): tab is (typeof tabs)[number] => Boolean(tab)),
    }))
    .filter(group => group.tabs.length > 0);
  if (!user) return null;
  return (
    <OperationsSurface className="mx-auto w-full max-w-[1600px] space-y-5 pb-8">
      <header className="flex flex-col gap-1">
        <p className="kicker font-bold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-300">Configuración</p>
        <h1 className="text-2xl font-bold text-primary">Tu negocio, tus equipos y tus preferencias</h1>
        <p className="text-sm text-secondary">{canManage ? 'Todo lo que define cómo funciona PALMYRA en este negocio, en un solo lugar.' : 'Gestiona tus avisos personales. Los ajustes del negocio requieren autorización.'}</p>
      </header>
      <SettingsSectionNav groups={navGroups} activeTab={activeTab} />
      <div className="min-w-0">
        {activeTab === 'notifications' ? <Notifications /> : canManage ? <SettingsAdminContent activeTab={activeTab} /> : null}
      </div>
    </OperationsSurface>
  );
}

function SettingsAdminContent({ activeTab }: { activeTab: SettingsSection }) {
  const navigate = useNavigate();
  const { 
    storeConfig, updateStoreConfig, 
    branches, addBranch, updateBranch, deleteBranch,
    categories, addCategory, updateCategory, deleteCategory,
    receiptConfig, updateReceiptConfig,
    currentUser,
    exportData, importData,
    products,
    transactions,
    syncWithSupabase,
    addNotification
  } = useStore(useShallow((state) => ({ 
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
    currentUser: state.currentUser, 
    exportData: state.exportData, 
    importData: state.importData, 
    products: state.products, 
    transactions: state.transactions, 
    syncWithSupabase: state.syncWithSupabase,
    addNotification: state.addNotification
  })));

  const [config, setConfig] = useState(storeConfig);
  const [ticketConfig, setTicketConfig] = useState(receiptConfig);
  useEffect(() => {
    setTicketConfig(receiptConfig);
  }, [receiptConfig]);

  // Respaldo cifrado previo a la migración guiada: usa la clave automática del
  // equipo (la misma que muestra «Respaldo en la nube») y descarga el archivo.
  const createPreMigrationBackup = async (): Promise<{ at: string; bytes: number } | null> => {
    let companyId = "";
    try {
      companyId = getPalmyraLocalScope()?.companyId ?? "";
    } catch {
      companyId = "";
    }
    let passphrase = "";
    try {
      passphrase = companyId ? window.localStorage.getItem(cloudRecoveryKeyStorageKey(companyId)) ?? "" : "";
    } catch {
      passphrase = "";
    }
    if (passphrase.length < 8) return null;
    const driver = await getRuntimeDriver();
    const result = await createBackupResult({
      driver,
      passphrase,
      meta: { app: "palmyra", version: PRODUCT_VERSION, kind: "pre-migracion" }
    });
    try {
      const blob = new Blob([result.bytes as unknown as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.summary.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      // La prueba de respaldo ya existe; la descarga se puede repetir.
    }
    return { at: result.summary.createdAt, bytes: result.summary.sizeBytes };
  };
  
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

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'ticket') return;
    let cancelled = false;
    void getConnectedDeviceName().then(name => {
      if (!cancelled && name) setPrinterStatus({ type: 'success', message: `Conectada: ${name}` });
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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
  // F6: la última importación rechazada alimenta la recuperación guiada; el
  // selector se dispara también desde ese panel, no solo desde el botón.
  const [backupImportError, setBackupImportError] = useState<string | null>(null);
  const backupImportInputRef = useRef<HTMLInputElement | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // navigator.onLine no provoca renders: sin este estado el botón de sincronizar
  // y el indicador de conexión quedaban congelados al recuperar la red.
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
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
  const lastScrolledTab = useRef(activeTab);

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
    // Solo al cambiar de sección: en la primera carga el navegador ya abre arriba.
    if (lastScrolledTab.current === activeTab) return;
    lastScrolledTab.current = activeTab;
    settingsContentRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
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

  const handleExportBackup = () => {
    try {
      const data = exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'palmyra-respaldo.json';
      // Firefox/Safari cancelan la descarga si el ancla no está en el documento
      // y si la URL se revoca antes de que el navegador la abra.
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast('Respaldo exportado correctamente.');
    } catch (exportError) {
      console.error('[PALMYRA] No se pudo exportar el respaldo:', exportError);
      showToast('No se pudo generar el respaldo en este dispositivo.', 'error');
    }
  };

  /**
   * Convierte el rechazo de una importación en un mensaje claro. Las razones
   * propias de PALMYRA (sin conexión, nube que no confirma) se muestran tal
   * cual; los errores técnicos de lectura del archivo se traducen.
   */
  const describeBackupImportFailure = (error?: string): string => {
    const raw = String(error ?? '').trim();
    if (!raw) {
      return 'El archivo elegido no es un respaldo válido de PALMYRA. Elige un archivo .json exportado desde Configuración.';
    }
    if (/sin conexi[oó]n|cola offline|no confirm/i.test(raw)) return raw;
    if (/unexpected|json|formato de backup|not valid|invalid|inesperado/i.test(raw)) {
      return 'El archivo elegido no es un respaldo válido de PALMYRA. Elige un archivo .json exportado desde Configuración.';
    }
    return raw;
  };

  const handleImportBackupFile = async (file: File | null) => {
    if (!file || isLoading) return;
    setBackupImportError(null);
    setIsLoading(true);
    try {
      const text = await file.text();
      const result = await importData(text);
      if (!result.success) {
        const message = describeBackupImportFailure(result.error);
        setBackupImportError(message);
        showToast(message, 'error');
        return;
      }
      showToast('Respaldo importado. La interfaz se recargará para aplicar los datos.');
      window.setTimeout(() => window.location.reload(), 600);
    } catch (importError) {
      console.error('[PALMYRA] No se pudo importar el respaldo:', importError);
      const message = describeBackupImportFailure(importError instanceof Error ? importError.message : '');
      setBackupImportError(message);
      showToast(message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectPrinter = async (mode: 'serial' | 'bluetooth') => {
    if (isInsideIframe()) {
      setPrinterStatus({ type: 'error', message: 'Abre PALMYRA en una pestaña nueva para conectar la impresora.' });
      return;
    }
    setPrinterStatus({ type: 'loading', message: mode === 'serial' ? 'Buscando impresora USB…' : 'Buscando impresora Bluetooth…' });
    try {
      if (mode === 'serial') await connectPrinter();
      else await connectBluetoothPrinter();
      setPrinterStatus({ type: 'success', message: mode === 'serial' ? 'Impresora USB/Serie lista.' : 'Impresora Bluetooth lista.' });
    } catch (error: any) {
      setPrinterStatus({ type: 'error', message: error?.message || 'No se pudo conectar la impresora.' });
    }
  };

  const handleTestPrint = async () => {
    setPrinterStatus({ type: 'loading', message: 'Enviando prueba…' });
    try {
      const method = await printESCPOS({
        lines: [
          config.storeName || 'PALMYRA',
          'PRUEBA DE IMPRESION',
          new Date().toLocaleString('es-CU'),
          'Si lees esto, la impresora esta lista.'
        ],
        width: ticketConfig.printerWidth || '80mm'
      });
      setPrinterStatus({ type: 'success', message: method === 'bluetooth' ? 'Prueba enviada por Bluetooth.' : 'Prueba enviada por USB/Serie.' });
    } catch (error: any) {
      setPrinterStatus({ type: 'error', message: error?.message || 'No hay una impresora conectada.' });
    }
  };

  const handleClearAppCache = async () => {
    if (isLoading) return;
    // Sin red, borrar el caché deja la app sin shell y la recarga falla.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      showToast("Necesitas conexión para limpiar el caché: la app se recargará y sin internet podría no abrir.", "error");
      return;
    }
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
    await runWithLoading('Sincronizando con la nube…', async () => {
    try {
      const { processOfflineQueue } = await import('../services/offlineSync');
      const { getOfflineQueueCount } = await import('../services/offlineQueue');
      const count = getOfflineQueueCount();
      if (count > 0) {
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
    });
  };

  return (
    <div data-palmi-content="settings" className="settings-page space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 w-full min-w-0 pb-8 relative overflow-x-hidden">
      {/* In-App Toast Notification */}
      {toast && (
        <div role="status" aria-live="polite" className="fixed top-2 right-2 sm:top-4 sm:right-4 z-[200] w-[calc(100vw-1rem)] sm:w-auto max-w-md min-w-0 animate-in slide-in-from-top-4 fade-in duration-300">
          <div className={cn(
            "p-4 rounded-2xl shadow-2xl border flex items-center gap-3 backdrop-blur-md",
            toast.type === 'success' ? "bg-emerald-950/95 text-emerald-100 border-emerald-800/80 shadow-emerald-900/30" :
            toast.type === 'error' ? "bg-rose-950/95 text-rose-100 border-rose-800/80 shadow-rose-900/30" :
            "bg-slate-900/95 text-white border-slate-700 shadow-slate-900/30"
          )}>
            {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
            {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
            {toast.type === 'info' && <Database className="w-5 h-5 text-violet-300 shrink-0" />}
            <div className="flex-1 text-xs font-bold leading-snug">{toast.message}</div>
            <button onClick={() => setToast(null)} className="p-1 hover:bg-white/10 rounded-lg transition-colors">
              <X className="w-4 h-4 text-slate-400 hover:text-white" />
            </button>
          </div>
        </div>
      )}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {(() => {
            const activeMeta = settingsTabs.find(tab => tab.id === activeTab);
            const ActiveIcon = activeMeta?.icon || SettingsIcon;
            return (
              <span className="shrink-0 rounded-xl bg-violet-50 p-2.5 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                <ActiveIcon size={18} />
              </span>
            );
          })()}
          <div className="min-w-0">
            <h2 className="text-xl font-bold leading-tight text-primary break-words">{settingsTabs.find(tab => tab.id === activeTab)?.label}</h2>
            <p className="text-sm font-medium text-secondary">{settingsTabs.find(tab => tab.id === activeTab)?.detail}</p>
          </div>
        </div>
        {activeTab === 'connectivity' && <button onClick={handleManualSync} disabled={isSyncing || !isOnline}
          className="flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-50 sm:w-auto">
          <RefreshCw size={16} className={isSyncing ? 'animate-spin' : ''} />{isSyncing ? 'Sincronizando…' : 'Sincronizar con la nube'}
        </button>}
      </header>

      {activeTab === 'company' && (currentUser?.role === 'admin' || currentUser?.permissions?.includes('employees.manage')) && <div className="bg-secondary border border-base rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="kicker font-bold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">Gestión de trabajadores</p>
          <h3 className="mt-1 text-base font-bold text-primary">Todo el equipo se administra desde una sola vista</h3>
          <p className="mt-1 text-sm font-medium text-secondary">Crear empleados, enviar invitaciones, asignar roles, permisos, salarios y almacenes ahora vive en <strong>Equipo</strong>.</p>
        </div>
        <button type="button" onClick={() => navigate("/team")} className="shrink-0 w-full sm:w-auto h-11 px-4 rounded-xl bg-violet-600 text-white text-sm font-semibold shadow-sm hover:bg-violet-700 transition-colors">Abrir equipo</button>
      </div>}

      <div ref={settingsContentRef} id="settings-section-content" className="grid scroll-mt-20 grid-cols-1 gap-3 min-w-0">
        {/* Conectividad y Sincronización */}
        {activeTab === 'connectivity' && (
          <div className="space-y-4">
            <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4">
              <SettingsSectionHeader icon={Wifi} title="Conectividad y nube" subtitle="Control del guardado offline y de la transferencia de datos." />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 p-3.5 bg-primary border border-base rounded-2xl hover:border-violet-300 transition-all">
                    <div className="flex-1 pr-2 min-w-0">
                      <div className="flex items-center gap-2">
                        <CloudUpload size={15} className="text-violet-600" />
                        <span className="text-sm font-bold text-primary">Sincronización manual</span>
                      </div>
                      <p className="mt-1 text-sm font-medium leading-6 text-muted">
                        Si se activa, el sistema NO subirá los datos automáticamente al recuperar internet. Deberás presionar «Sincronizar con la nube» manualmente para evitar errores por caídas de conexión.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={config.manualOfflineSync === true}
                      aria-label="Activar sincronización manual"
                      onClick={() => {
                        const enabled = !(config.manualOfflineSync === true);
                        const newConfig = { ...config, manualOfflineSync: enabled };
                        setConfig(newConfig);
                        updateStoreConfig(newConfig);
                        showToast(`Sincronización manual ${enabled ? 'activada' : 'desactivada'}.`, 'info');
                      }}
                      className="relative h-11 w-12 shrink-0 rounded-full"
                    >
                      <span className={cn('absolute left-0 top-1/2 h-7 w-12 -translate-y-1/2 rounded-full border transition-colors', config.manualOfflineSync ? 'bg-violet-600 border-violet-600' : 'bg-slate-300 border-slate-400 dark:bg-slate-600 dark:border-slate-500')}>
                        <span className={cn('absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all', config.manualOfflineSync ? 'left-[23px]' : 'left-[3px]')} />
                      </span>
                    </button>
                  </div>

               <div className="bg-amber-50/50 dark:bg-amber-950/10 p-3.5 rounded-2xl border border-amber-100 dark:border-amber-900/30 flex items-start gap-3">
                    <AlertTriangle size={17} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-400 font-medium leading-6">
                      <strong>Recomendación:</strong> activa el modo manual en zonas con internet inestable. El sistema guardará todo en una cola local protegida y solo subirá cuando tú lo decidas, garantizando la integridad de cada transacción.
                    </p>
                  </div>
                </div>

                <div className="bg-primary p-4 rounded-2xl border border-base border-dashed flex flex-col justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-primary flex items-center gap-2">
                      <Database size={15} className="text-violet-600" />
                      Estado de la base de datos
                    </h4>
                    <div className="grid grid-cols-2 gap-3 mt-4">
                      <div className="p-3 bg-secondary rounded-xl border border-base">
                        <p className="text-sm font-medium text-muted">Productos</p>
                        <p className="text-lg font-bold text-primary tabular-nums">{products.length}</p>
                      </div>
                      <div className="p-3 bg-secondary rounded-xl border border-base">
                        <p className="text-sm font-medium text-muted">Ventas</p>
                        <p className="text-lg font-bold text-primary tabular-nums">{transactions.length}</p>
                      </div>
                    </div>
                  </div>
                  <p className="mt-4 flex items-center justify-center gap-2 text-sm font-medium text-muted">
                    <span className={cn('h-2 w-2 rounded-full', isOnline ? 'bg-emerald-500' : 'bg-amber-500')} />
                    {isOnline ? 'Dispositivo en línea' : 'Dispositivo sin conexión'}
                  </p>
                </div>
              </div>
            </div>

            <OfflineHealthSection />
          </div>
        )}

        {/* Datos de la Empresa */}
        {activeTab === 'company' && (
          <div className="space-y-3 min-w-0">
            <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4 min-w-0">
              <SettingsSectionHeader icon={Store} title="Datos de la empresa" subtitle="Nombre, teléfono y dirección que aparecen en tickets y reportes." />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1.5 min-w-0">
                  <span className="text-sm font-semibold text-muted">Nombre del negocio</span>
                  <input type="text" value={config.storeName}
                    onChange={e => setConfig({ ...config, storeName: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500 shadow-sm" />
                </label>
                <label className="space-y-1.5 min-w-0">
                  <span className="text-sm font-semibold text-muted">Teléfono</span>
                  <input type="text" value={config.phone}
                    onChange={e => setConfig({ ...config, phone: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500 shadow-sm" />
                </label>
                <label className="space-y-1.5 md:col-span-2 min-w-0">
                  <span className="text-sm font-semibold text-muted">Dirección</span>
                  <input type="text" value={config.address}
                    onChange={e => setConfig({ ...config, address: e.target.value })}
                    className="w-full min-w-0 px-3 sm:px-4 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500 shadow-sm" />
                </label>
              </div>

              <div className="pt-1 flex justify-end">
                <button onClick={handleSaveConfig}
                  className="w-full sm:w-auto px-5 h-11 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors shadow-sm flex items-center justify-center gap-2 cursor-pointer">
                  <Save size={15} /> Guardar cambios
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Monedas y tasas */}
        <SettingsCurrencySection active={activeTab === 'currency'} onToast={showToast} />

        {/* Red local: primero la conexión práctica y la lista de equipos; el
            emparejamiento entre aplicaciones instaladas queda plegado. */}
        {activeTab === 'lan' && (
          <div className="space-y-4 min-w-0">
            <SettingsLanSection active onToast={showToast} />
            <details className="rounded-2xl border border-base bg-secondary shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 sm:p-5">
                <span className="flex min-w-0 items-center gap-2">
                  <Link2 size={16} className="shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Vincular otra PC instalada</span>
                    <span className="block text-sm font-medium text-muted">Genera aquí la invitación en la PC principal; pégala en la otra PC para compartir la operación.</span>
                  </span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-muted" />
              </summary>
              <div className="border-t border-base p-3 sm:p-5">
                <LanPanel />
              </div>
            </details>
          </div>
        )}

        {/* Diagnóstico de escritorio: solo se pinta en el shell Electron */}
        {activeTab === 'lan' && (
          <div id="desktop-diagnostics" className="scroll-mt-20">
            <DesktopDiagnostics />
          </div>
        )}

        {/* Estilo visual */}
        {activeTab === 'visual' && visualStyleLocked && (
          <PlanFeatureGate feature="visual_style" title="Estilo visual del software" description="Personaliza la experiencia visual de PALMYRA y adapta la lectura de la interfaz a tu equipo. Disponible desde Caravana." highlights={[
            "Ajusta el tamaño de lectura de toda la interfaz",
            "Los cambios se aplican al instante, sin recargar",
            "Se conservan en este dispositivo"
          ]} />
        )}

        {activeTab === 'visual' && !visualStyleLocked && (
          <div className="space-y-4">
            <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-5">
              <SettingsSectionHeader icon={Palette} title="Estilo visual del software" subtitle="Personaliza la lectura sin cambiar la estructura de PALMYRA." />
              <div className="p-4 rounded-2xl border border-base bg-subtle">
                <div className="flex items-start gap-3">
                  <Type className="w-5 h-5 text-violet-600 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-bold text-primary">Tamaño de las letras</h4>
                    <p className="mt-1 text-sm font-medium leading-6 text-muted">El cambio se aplica inmediatamente a toda la interfaz y se conserva en este dispositivo.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                      {[
                        {value:0.9,label:'Pequeña',sample:'Aa'},
                        {value:1,label:'Normal',sample:'Aa'},
                        {value:1.1,label:'Grande',sample:'Aa'},
                        {value:1.2,label:'Muy grande',sample:'Aa'}
                      ].map(option => (
                        <button key={option.value} type="button" onClick={() => setFontScale(option.value)}
                          className={cn("rounded-xl border p-3 text-left transition-all", fontScale === option.value ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30 ring-2 ring-violet-500/15" : "border-base bg-primary hover:bg-subtle")}>
                          <span className="block font-bold text-primary" style={{fontSize: (22 * option.value) + 'px'}}>{option.sample}</span>
                          <span className="block text-sm font-semibold text-primary mt-1">{option.label}</span>
                          <span className="block text-sm text-muted">{Math.round(option.value*100)}%</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="p-4 rounded-2xl border border-base bg-primary flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div><h4 className="text-sm font-bold text-primary">Vista recomendada</h4><p className="mt-1 text-sm font-medium text-muted">Normal es el tamaño equilibrado para POS, tablets y escritorio.</p></div>
                <button type="button" onClick={() => setFontScale(1)} className="h-11 shrink-0 px-4 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700">Restablecer</button>
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
            <SettingsSectionHeader icon={Printer} title="Impresora térmica" subtitle="Conexión de la impresora y formato de los comprobantes del negocio." />
            {isInIframe && (
              <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                Abre PALMYRA en una pestaña completa para conectar la impresora: el navegador bloquea USB y Bluetooth dentro de marcos.
              </p>
            )}
            <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-primary">Conexión de la impresora</p>
                {printerStatus && (
                  <span role="status" aria-live="polite" className={cn(
                    "text-sm font-semibold",
                    printerStatus.type === 'success' ? "text-emerald-600 dark:text-emerald-400" : printerStatus.type === 'error' ? "text-rose-600 dark:text-rose-400" : "text-violet-600 dark:text-violet-300"
                  )}>
                    {printerStatus.type === 'loading' ? <RefreshCw size={14} className="inline animate-spin mr-1" /> : null}
                    {printerStatus.message}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button type="button" onClick={() => void handleConnectPrinter('serial')} disabled={printerStatus?.type === 'loading'}
                  className="h-11 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-subtle transition-colors disabled:opacity-50">
                  <Usb size={15} /> USB / Serie
                </button>
                <button type="button" onClick={() => void handleConnectPrinter('bluetooth')} disabled={printerStatus?.type === 'loading'}
                  className="h-11 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-subtle transition-colors disabled:opacity-50">
                  <Bluetooth size={15} /> Bluetooth
                </button>
                <button type="button" onClick={() => void handleTestPrint()} disabled={printerStatus?.type === 'loading'}
                  className="h-11 rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-violet-700 transition-colors disabled:opacity-50">
                  <Printer size={15} /> Imprimir prueba
                </button>
              </div>
              <p className="text-sm font-medium leading-6 text-muted">
                El navegador pedirá permiso la primera vez. La conexión queda activa mientras la pestaña siga abierta; en el POS instalado se reconecta sola si la opción de abajo está activa.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50/60 dark:bg-violet-950/20 dark:border-violet-900/40 p-3 md:col-span-2">
                <div className="min-w-0">
                  <span className="block text-sm font-bold text-violet-900 dark:text-violet-100">Siempre conectarse automáticamente</span>
                  <span className="mt-0.5 block text-sm font-medium text-violet-700/80 dark:text-violet-300/80">Al abrir PALMYRA o la PWA intentará reconectar la última impresora autorizada.</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoConnectPrinter}
                  aria-label="Reconectar la impresora automáticamente"
                  onClick={() => {
                    const enabled = !autoConnectPrinter;
                    setAutoConnectPrinter(enabled);
                    setThermalPrinterAutoConnect(enabled);
                  }}
                  className="relative h-11 w-12 shrink-0 rounded-full"
                >
                  <span className={cn('absolute left-0 top-1/2 h-7 w-12 -translate-y-1/2 rounded-full border transition-colors', autoConnectPrinter ? 'bg-violet-600 border-violet-600' : 'bg-slate-300 border-slate-400 dark:bg-slate-600 dark:border-slate-500')}>
                    <span className={cn('absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all', autoConnectPrinter ? 'left-[23px]' : 'left-[3px]')} />
                  </span>
                </button>
              </div>
              {[['showLogo','Mostrar logo'],['showAddress','Mostrar dirección'],['showPhone','Mostrar teléfono'],['showFooter','Mostrar pie del ticket'],['autoPrint','Imprimir automáticamente']].map(([key,label]) => (
                <label key={key} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-base bg-primary p-3 cursor-pointer">
                  <span className="text-sm font-semibold text-primary">{label}</span>
                  <input type="checkbox" checked={Boolean((ticketConfig as any)[key])} onChange={e => setTicketConfig(prev => ({ ...prev, [key]: e.target.checked }))} className="h-4 w-4 accent-violet-600" />
                </label>
              ))}
              <label className="space-y-1.5"><span className="text-sm font-semibold text-muted">Ancho</span><select value={ticketConfig.printerWidth || '80mm'} onChange={e => setTicketConfig(prev => ({ ...prev, printerWidth: e.target.value as '58mm' | '80mm' }))} className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary"><option value="58mm">58 mm</option><option value="80mm">80 mm</option></select></label>
              <label className="space-y-1.5 md:col-span-2"><span className="text-sm font-semibold text-muted">Texto del pie</span><textarea value={ticketConfig.footerText || ''} onChange={e => setTicketConfig(prev => ({ ...prev, footerText: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary resize-y" /></label>
            </div>
            <div className="flex justify-end"><button type="button" onClick={handleSaveTicket} className="w-full sm:w-auto px-5 h-11 bg-violet-600 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2 hover:bg-violet-700 transition-colors"><Save size={15}/> Guardar configuración de ticket</button></div>
          </div>
        )}

        {activeTab === 'piloto' && (
          <div className="space-y-4 min-w-0">
            <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-3 sm:p-5 dark:border-violet-900/40 dark:bg-violet-950/20">
              <p className="flex items-center gap-2 text-sm font-bold text-violet-900 dark:text-violet-100">
                <ClipboardCheck size={16} className="shrink-0" /> Seguimiento automático del piloto
              </p>
              <p className="mt-1.5 text-sm font-medium leading-6 text-violet-800/85 dark:text-violet-200/85">
                Estas cifras se arman solas con lo que ya registra el equipo: ventas, cola offline, sincronización y
                actualizaciones. No tienes que activar ni configurar nada.
              </p>
            </div>
            <PilotMetricsPanel />
            <details className="rounded-2xl border border-base bg-secondary shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 sm:p-5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <CheckCircle2 size={16} className="shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Puesta en marcha · 7 comprobaciones</span>
                    <span className="block text-sm font-medium text-muted">Se hacen una sola vez al instalar. Márcalas cuando estén probadas en el equipo real.</span>
                  </span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-muted" />
              </summary>
              <div className="border-t border-base p-3 sm:p-5">
                <PilotChecklist />
              </div>
            </details>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="space-y-4 min-w-0">
            <div className="rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-5">
              <SettingsSectionHeader icon={AlertTriangle} title="Administración avanzada" subtitle="Todo lo delicado, ordenado y con confirmación." />
              <p className="mt-2 text-sm font-medium leading-6 text-muted">
                PALMYRA respalda, sincroniza y busca actualizaciones por su cuenta. Abre estos bloques solo para revisar
                el estado o reparar algo; vender no depende de esta pantalla.
              </p>
            </div>

            {/* F6: recuperación guiada; solo aparece con un fallo real de base o de respaldo. */}
            <RecoveryAssistant
              importError={backupImportError}
              onPickBackup={() => backupImportInputRef.current?.click()}
              onDismissImportError={() => setBackupImportError(null)}
            />

            <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm" aria-labelledby="adv-backups">
              <div className="flex items-start gap-3 p-3 sm:p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                  <CloudDownload size={17} className="shrink-0" />
                </span>
                <div className="min-w-0">
                  <h2 id="adv-backups" className="text-base font-bold text-primary">Respaldos</h2>
                  <p className="mt-0.5 text-sm font-medium leading-6 text-muted">
                    Copia cifrada del equipo y respaldo diario en la nube. Se crean solos; aquí puedes crear uno extra o
                    restaurar.
                  </p>
                </div>
              </div>
              <div className="border-t border-base p-3 sm:p-5">
                <BackupPanel />
              </div>
            </section>

            <details className="rounded-2xl border border-base bg-secondary shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 sm:p-5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <RefreshCw size={16} className="shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Actualizaciones</span>
                    <span className="block text-sm font-medium text-muted">Se buscan al abrir PALMYRA. Aquí puedes comprobarlo a mano o instalar desde un archivo.</span>
                  </span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-muted" />
              </summary>
              <div className="space-y-3 border-t border-base p-3 sm:p-5">
                <UpdateCenter />
                <AndroidManualUpdate />
              </div>
            </details>

            <details className="rounded-2xl border border-base bg-secondary shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 sm:p-5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Database size={16} className="shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Diagnóstico y soporte</span>
                    <span className="block text-sm font-medium text-muted">Datos técnicos para revisar un problema con soporte. No hace falta abrirlo para operar.</span>
                  </span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-muted" />
              </summary>
              <div className="space-y-3 border-t border-base p-3 sm:p-5">
                <InstallDiagnostics />
                <AndroidBackupStatus />
                <AndroidDiagnostics />
                <RequestBudgetPanel />
                <GuidedMigrationPanel onCreateBackup={createPreMigrationBackup} />
              </div>
            </details>

            <details className="rounded-2xl border border-amber-200 bg-secondary shadow-sm dark:border-amber-900/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 sm:p-5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <AlertTriangle size={16} className="shrink-0 text-amber-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Reparación y restablecimiento</span>
                    <span className="block text-sm font-medium text-muted">Sincronización manual, limpieza de caché y borrado selectivo. Todo pide confirmación.</span>
                  </span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-muted" />
              </summary>
              <div className="space-y-3 border-t border-base p-3 sm:p-5">
                <button
                  type="button"
                  onClick={async () => {
                    const { refreshRealtimeNow } = await import("../services/realtimeSync");
                    const ok = await refreshRealtimeNow();
                    showToast(ok ? "Datos sincronizados ahora." : "No hay nada nuevo que sincronizar o no hay conexión.", ok ? "success" : "info");
                  }}
                  className="h-11 rounded-xl border border-base bg-primary px-4 text-sm font-semibold text-primary hover:bg-subtle transition-colors flex items-center justify-center gap-2"
                >
                  <RefreshCw size={16} /> Sincronizar datos ahora
                </button>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  <button type="button" onClick={handleExportBackup} className="h-11 rounded-xl border border-base bg-primary text-primary text-sm font-semibold flex items-center justify-center gap-2 hover:bg-subtle transition-colors"><CloudDownload size={16}/> Exportar respaldo</button>
                  <label className="h-11 rounded-xl border border-base bg-primary text-primary text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer hover:bg-subtle transition-colors">
                    <CloudUpload size={16}/> Importar respaldo
                    <input type="file" accept="application/json,.json" ref={backupImportInputRef} className="sr-only" disabled={isLoading} onChange={e => {
                      const file = e.target.files?.[0] ?? null;
                      e.target.value = '';
                      void handleImportBackupFile(file);
                    }} />
                  </label>
                  <button type="button" onClick={handleClearAppCache} disabled={isLoading} className="h-11 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-900/40 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-amber-100/70 disabled:opacity-50 transition-colors"><RefreshCw size={16}/> Borrar caché</button>
                  <button type="button" onClick={() => setShowConfirmReset(true)} className="h-11 rounded-xl border border-rose-200 bg-primary text-rose-700 dark:border-rose-900/40 dark:text-rose-300 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors"><Trash2 size={16}/> Restablecer datos</button>
                </div>
                <p className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20 p-3 text-sm font-medium leading-6 text-amber-800 dark:text-amber-300">El restablecimiento es selectivo. No modifica la cuenta SaaS, el plan ni la autenticación.</p>
                {showConfirmReset && (
                  <div className="rounded-2xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/60 dark:bg-rose-950/20 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-rose-700 dark:text-rose-300">Selecciona qué restablecer</p><button type="button" onClick={toggleAllResetSections} className="min-h-11 px-2 text-sm font-semibold text-rose-600 underline-offset-4 hover:underline">{resetSections.length === RESET_OPTIONS.length ? 'Quitar todo' : 'Seleccionar todo'}</button></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{RESET_OPTIONS.map(option => { const Icon=option.icon; const checked=resetSections.includes(option.id); return <label key={option.id} className={cn('flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer',checked?'border-rose-300 bg-primary dark:border-rose-900/50':'border-base bg-primary')}><input type="checkbox" checked={checked} onChange={()=>toggleResetSection(option.id)} className="mt-0.5 h-4 w-4 accent-rose-600"/><Icon size={15} className="text-rose-600 mt-0.5 shrink-0"/><span className="min-w-0"><span className="block text-sm font-semibold text-primary">{option.label}</span><span className="mt-0.5 block text-sm font-medium leading-snug text-muted">{option.desc}</span></span></label>; })}</div>
                    <input value={resetInput} onChange={e=>setResetInput(e.target.value)} placeholder="Escribe ELIMINAR para confirmar" className="w-full px-3 py-2.5 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-rose-500"/>
                    <div className="flex gap-2"><button type="button" onClick={()=>{setShowConfirmReset(false);setResetInput('');setResetSections([])}} className="flex-1 h-11 rounded-xl border border-base text-sm font-semibold text-primary hover:bg-subtle">Cancelar</button><button type="button" disabled={resetInput.trim().toUpperCase()!=='ELIMINAR'||resetSections.length===0||isLoading} onClick={handleClearData} className="flex-1 h-11 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-40">{isLoading?'Procesando…':'Confirmar'}</button></div>
                  </div>
                )}
              </div>
            </details>
          </div>
        )}

        {(branchToDelete || categoryToDelete) && (
          <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-slate-950/50 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-3xl bg-secondary border border-base shadow-2xl p-5">
              <div className="flex items-center gap-3"><AlertTriangle className="w-5 h-5 text-rose-600"/><h3 className="text-base font-bold text-primary">Confirmar eliminación</h3></div>
              <p className="mt-3 text-sm text-secondary">¿Seguro que deseas eliminar <strong>{branchToDelete?.name || categoryToDelete?.name}</strong>? Los registros históricos no se borrarán.</p>
              <div className="mt-5 flex gap-2"><button type="button" onClick={() => { setBranchToDelete(null); setCategoryToDelete(null); }} className="flex-1 h-11 rounded-xl border border-base text-sm font-semibold text-primary hover:bg-subtle">Cancelar</button><button type="button" onClick={() => branchToDelete ? confirmDeleteBranch() : confirmDeleteCategory()} className="flex-1 h-11 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700">Eliminar</button></div>
            </div>
          </div>
        )}


      </div>


    </div>
  );
}

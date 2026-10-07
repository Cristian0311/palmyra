import type { Branch } from '../../types';
import type { AppState } from '../storeTypes';
import {
  clearSupabaseData,
  clearSelectedDataFromSupabase,
  pushUserToSupabase,
  deleteUserFromSupabase,
} from '../../services/supabaseSync';
import { getOfflineQueue, enqueueOfflineItem } from '../../services/offlineQueue';
import { flushLocalStateStorage, clearLocalStateStorage } from '../../services/localStateStorage';
import { signInSaaSAccount, signOutSaaSAccount, loadSaaSContext } from '../../services/saas';
import { INITIAL_USERS, INITIAL_CURRENCIES, INITIAL_FISCAL_CONFIGS } from '../storeInitialData';

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

export function createAuthActions(set: StoreSet, get: StoreGet): any {
  return {
  login: async (email, pass) => {
    try {
      const { data, error } = await signInSaaSAccount(email, pass);
      if (error || !data.user) return false;
      const ctx = await loadSaaSContext();
      if (!ctx) return false;
      set({
        currentUser: ctx.user,
        currentBranchId: ctx.warehouseIds[0] || get().currentBranchId || ''
      });
      return true;
    } catch {
      return false;
    }
  },
  logout: () => {
    set({ currentUser: null, cart: [], activeSessionId: null, currentBranchId: '' });
    void signOutSaaSAccount().catch(() => {});
    void import('../../services/tenant').then(({ clearActiveTenant }) => clearActiveTenant()).catch(() => {});
  },
  clearAllData: async () => {
    // A full reset must never leave durable business operations behind.
    // Otherwise the cloud is emptied and the offline queue can repopulate it
    // later, resurrecting old sales or cash sessions.
    const pendingQueue = getOfflineQueue().filter(item => item.status !== 'conflict');
    if (pendingQueue.length > 0) {
      get().addNotification(
        `No se puede borrar todo mientras hay ${pendingQueue.length} operación(es) offline pendientes. Sincronízalas primero.`,
        'warning'
      );
      return;
    }

    // 1. Clear Supabase first. Nunca limpiamos el dispositivo si la nube no
    // confirmó TODAS las tablas, porque eso produciría divergencia irrecuperable.
    let remoteReset: any;
    try {
      remoteReset = await Promise.race([
        clearSupabaseData('ELIMINAR'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Supabase')), 12000))
      ]);
    } catch (err: any) {
      const message = err?.message || 'Error de conexión con Supabase';
      get().addNotification('No se realizó el borrado total local.', 'error', message);
      console.error('[clearAllData] Supabase clear failed; local state preserved:', err);
      return;
    }

    if (!remoteReset?.success) {
      const details = Array.isArray(remoteReset?.failed) && remoteReset.failed.length
        ? remoteReset.failed.join(' · ')
        : 'Supabase no confirmó el borrado total.';
      get().addNotification('No se realizó el borrado total local.', 'error', details);
      console.error('[clearAllData] Remote reset incomplete; local state preserved:', remoteReset);
      return;
    }

    // Clear local storage/IndexedDB cache.
    await clearLocalStateStorage().catch(() => {});
    try {
      const protectedKeys = new Set(['pos_offline_sync_queue', 'palmyra_supabase_url', 'palmyra_supabase_anon_key', 'palmyra-pos-device-id']);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && !protectedKeys.has(key)) localStorage.removeItem(key);
      }
    } catch (e) {
      console.error('[clearAllData] Error limpiando caché local:', e);
    }

    // 2. Reset local state to absolute minimal (only first admin)
    const minUsers = [INITIAL_USERS[0]];
    const minBranches: Branch[] = [];
    
    set({
      users: minUsers,
      currentUser: null,
      branches: minBranches,
      currentBranchId: '',
      categories: [],
      products: [],
      inventory: [],
      customers: [],
      transactions: [],
      returns: [],
      warranties: [],
      cashSessions: [],
      transfers: [],
      suppliers: [],
      supplierOrders: [],
      inventoryAudits: [],
      salarySettlements: [],
      fiscalConfigs: INITIAL_FISCAL_CONFIGS,
      bankCards: [],
      bankTransactions: [],
      demandForecasts: [],
      quotes: [],
      timeShifts: [],
      pendingOrders: [],
      cart: [],
      currentCustomerId: undefined,
      lastTurnNumber: 0,
      activeSessionId: null
    });

    // 3. Re-push minimal data to Supabase to avoid lock-out
    await pushUserToSupabase(minUsers[0]);
  },
  resetSelectedData: async (sections) => {
    const selected = new Set(sections);
    const queueSensitive = ['inventory', 'reports', 'cash', 'purchases', 'suppliers', 'customers', 'bank'];
    const pendingQueue = getOfflineQueue();
    if (pendingQueue.length > 0 && sections.some(section => queueSensitive.includes(section))) {
      return { success: false, failed: [`Hay ${pendingQueue.length} operación(es) pendientes en la cola offline. Sincronízalas antes de restablecer datos operativos.`] };
    }
    const remote = await clearSelectedDataFromSupabase(sections);
    if (!remote.success) return remote;
    const patch: any = {};

    if (selected.has('inventory')) { patch.inventory = []; patch.transfers = []; }
    if (selected.has('reports')) {
      patch.transactions = []; patch.returns = []; patch.warranties = []; patch.cashSessions = [];
      patch.salarySettlements = []; patch.inventoryAudits = []; patch.bankTransactions = [];
      patch.timeShifts = []; patch.notifications = [];
    }
    if (selected.has('customers')) patch.customers = [];
    if (selected.has('suppliers') || selected.has('purchases')) {
      if (selected.has('suppliers')) patch.suppliers = [];
      if (selected.has('purchases')) patch.supplierOrders = [];
    }
    if (selected.has('cash')) { patch.cashSessions = []; patch.salarySettlements = []; }
    if (selected.has('bank')) { patch.bankCards = []; patch.bankTransactions = []; }
    if (selected.has('users')) { patch.users = [INITIAL_USERS[0]]; patch.currentUser = null; }
    if (selected.has('branches')) { patch.branches = []; patch.currentBranchId = ''; }
    if (selected.has('quotes')) { patch.quotes = []; patch.pendingOrders = []; }
    if (selected.has('settings')) {
      patch.currencies = INITIAL_CURRENCIES;
      patch.fiscalConfigs = INITIAL_FISCAL_CONFIGS;
      patch.storeConfig = { storeName: 'Mi Tienda POS', address: 'Calle Principal 123', phone: '+53 51234567', receiptNotes: '¡Gracias por su compra!', darkMode: false, manualOfflineSync: false };
    }

    patch.cart = []; patch.currentCustomerId = undefined; patch.activeSessionId = null;
    set(patch);

    // Forzar la escritura diferida antes de devolver el control. Esto evita
    // que una recarga inmediata restaure el snapshot anterior desde IndexedDB.
    try { await flushLocalStateStorage(); } catch {}
    return;
  },
  clearReportsHistory: async () => {
    // Primero se confirma la limpieza remota. Nunca debemos vaciar el estado
    // local si Supabase falló, porque eso dejaría el dispositivo divergente de la nube.
    try {
      const { clearHistoryFromSupabase } = await import('../../services/supabaseSync');
      const remote = await clearHistoryFromSupabase();
      if (!remote?.success) {
        const details = Array.isArray(remote?.failed) && remote.failed.length
          ? remote.failed.join(' · ')
          : 'Supabase no pudo confirmar la limpieza del historial.';
        get().addNotification('No se limpió el historial local porque la nube no confirmó la operación.', 'error', details);
        return;
      }
    } catch (err: any) {
      console.warn("Supabase history clear failed; keeping local history:", err);
      get().addNotification('No se limpió el historial local porque la nube no confirmó la operación.', 'error', err?.message || 'Error de conexión.');
      return;
    }

    // Solo después de confirmación remota se limpia el estado local.
    set({ 
      transactions: [],
      returns: [],
      warranties: [],
      cashSessions: [],
      bankTransactions: [],
      inventoryAudits: [],
      salarySettlements: [],
      pendingOrders: [],
      cart: [],
      notifications: []
    });
    return;
  },
  exportData: () => {
    const state = get();
    const backupData = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        categories: state.categories,
        products: state.products,
        inventory: state.inventory,
        branches: state.branches,
        currencies: state.currencies,
        customers: state.customers,
        users: state.users,
        transactions: state.transactions,
        returns: state.returns,
        warranties: state.warranties,
        cashSessions: state.cashSessions,
        transfers: state.transfers,
        suppliers: state.suppliers,
        supplierOrders: state.supplierOrders,
        inventoryAudits: state.inventoryAudits,
        salarySettlements: state.salarySettlements,
        fiscalConfigs: state.fiscalConfigs,
        bankCards: state.bankCards,
        bankTransactions: state.bankTransactions,
        demandForecasts: state.demandForecasts,
        quotes: state.quotes,
        timeShifts: state.timeShifts,
        pendingOrders: state.pendingOrders,
        receiptConfig: state.receiptConfig,
        storeConfig: state.storeConfig
      }
    };
    return JSON.stringify(backupData, null, 2);
  },
  importData: async (jsonData: string) => {
    try {
      const backup = JSON.parse(jsonData);
      if (!backup.data || !backup.version) {
        throw new Error("Formato de backup inválido");
      }

      const d = backup.data;

      // Una importación de respaldo reemplaza el estado completo. No debe
      // ejecutarse como si estuviera confirmada cuando el dispositivo está
      // offline, porque pushAllToSupabase no es una operación transaccional.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('No se puede importar el respaldo mientras el dispositivo está sin conexión. Conéctate y vuelve a intentarlo.');
      }

      // Conservamos un snapshot local para poder deshacer el reemplazo si la
      // confirmación remota falla. Sin esto, un import parcialmente rechazado
      // podía dejar el dispositivo mostrando datos que la nube nunca aceptó.
      const previousImportState = {
        categories: get().categories,
        products: get().products,
        inventory: get().inventory,
        branches: get().branches,
        currencies: get().currencies,
        customers: get().customers,
        users: get().users,
        transactions: get().transactions,
        returns: get().returns,
        warranties: get().warranties,
        cashSessions: get().cashSessions,
        transfers: get().transfers,
        suppliers: get().suppliers,
        supplierOrders: get().supplierOrders,
        inventoryAudits: get().inventoryAudits,
        salarySettlements: get().salarySettlements,
        fiscalConfigs: get().fiscalConfigs,
        bankCards: get().bankCards,
        bankTransactions: get().bankTransactions,
        demandForecasts: get().demandForecasts,
        quotes: get().quotes,
        timeShifts: get().timeShifts,
        pendingOrders: get().pendingOrders,
        receiptConfig: get().receiptConfig,
        storeConfig: get().storeConfig
      };

      // Update local state
      set({
        categories: d.categories || [],
        products: d.products || [],
        inventory: d.inventory || [],
        branches: d.branches || [],
        currencies: d.currencies || [],
        customers: d.customers || [],
        users: d.users || [],
        transactions: d.transactions || [],
        returns: d.returns || [],
        warranties: d.warranties || [],
        cashSessions: d.cashSessions || [],
        transfers: d.transfers || [],
        suppliers: d.suppliers || [],
        supplierOrders: d.supplierOrders || [],
        inventoryAudits: d.inventoryAudits || [],
        salarySettlements: d.salarySettlements || [],
        fiscalConfigs: d.fiscalConfigs || [],
        bankCards: d.bankCards || [],
        bankTransactions: d.bankTransactions || [],
        demandForecasts: d.demandForecasts || [],
        quotes: d.quotes || [],
        timeShifts: d.timeShifts || [],
        pendingOrders: d.pendingOrders || [],
        receiptConfig: d.receiptConfig || get().receiptConfig,
        storeConfig: d.storeConfig || get().storeConfig
      });

      // After local update, sync everything to Supabase
      const { pushAllToSupabase } = await import('../../services/supabaseSync');
      const syncResult = await pushAllToSupabase(true);
      if (!syncResult.success) {
        set(previousImportState);
        throw new Error(
          syncResult.errors?.length
            ? `La importación fue cancelada porque Supabase no confirmó todos los datos: ${syncResult.errors.join(' · ')}`
            : 'La importación fue cancelada porque Supabase no confirmó la operación completa.'
        );
      }

      return { success: true };
    } catch (err: any) {
      console.error("Error importing data:", err);
      return { success: false, error: err.message };
    }
  },
  addUser: (user) => {
    const exists = get().users.find(u => 
      (u.email && u.email.toLowerCase() === user.email?.toLowerCase()) || 
      ((u.name || '').toLowerCase() === (user.name || '').toLowerCase())
    );
    if (exists) {
      return get().updateUser(exists.id, user);
    }
    set((state) => ({ users: [...state.users, user] }));
    pushUserToSupabase(user);
  },
  registerEmployee: (name, password) => {
    const newUser: import('../../types').User = {
      id: crypto.randomUUID(),
      name,
      email: `${String(name || 'user').toLowerCase().replace(/\s/g, '')}_${Math.floor(1000 + Math.random() * 9000)}@system.local`,
      password,
      role: 'employee',
      permissions: ['pos_access'],
      isActive: true,
      baseSalary: 0
    };
    set((state) => ({ users: [...state.users, newUser] }));
    pushUserToSupabase(newUser);
    return newUser;
  },
  updateUser: (id, user) => {
    set((state) => ({
      users: state.users.map(u => u.id === id ? { ...u, ...user } : u)
    }));
    const updatedUser = get().users.find(u => u.id === id);
    if (updatedUser) pushUserToSupabase(updatedUser);
  },
  deleteUser: (id) => {
    set((state) => ({
      users: state.users.map(u => u.id === id ? { ...u, isActive: false } : u)
    }));
    const actionId = 'user-delete:' + id;
    const queueDeletion = () => enqueueOfflineItem('user_delete', { id }, actionId)
      .catch((error) => console.warn('[PALMYRA] No se pudo guardar el retiro del empleado en la cola:', error));
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      deleteUserFromSupabase(id).then((ok) => {
        if (!ok) queueDeletion();
      }).catch(() => queueDeletion());
    } else {
      queueDeletion();
    }
  },
  };
}

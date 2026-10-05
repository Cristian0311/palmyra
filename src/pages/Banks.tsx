import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { generateId, cn } from '../lib/utils';
import { CreditCard, Plus, ArrowUpRight, ArrowDownRight, Activity, Trash2, ShieldCheck, RefreshCw, List, X, CheckCircle2 } from 'lucide-react';
import { BankCard, BankTransaction } from '../types';
import { InfoTooltip } from '../components/InfoTooltip';
import { enqueueOfflineItem, getOfflineQueue, removeFromOfflineQueue } from '../services/offlineQueue';
import { callBankInternalTransferRPC } from '../services/supabaseSync';

export default function Banks() {
  const { 
    bankCards, 
    bankTransactions, 
    addBankCard, 
    updateBankCard, 
    deleteBankCard, 
    getBaseCurrency, 
    addBankTransaction,
    deleteBankTransaction,
    reconcileBankBalances,
    addNotification
  } = useStore(useShallow((state) => ({ bankCards: state.bankCards, bankTransactions: state.bankTransactions, addBankCard: state.addBankCard, updateBankCard: state.updateBankCard, deleteBankCard: state.deleteBankCard, getBaseCurrency: state.getBaseCurrency, addBankTransaction: state.addBankTransaction, deleteBankTransaction: state.deleteBankTransaction, reconcileBankBalances: state.reconcileBankBalances, addNotification: state.addNotification })));
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [editingCard, setEditingCard] = useState<BankCard | null>(null);
  
  const [formData, setFormData] = useState<Partial<BankCard>>({
    name: "",
    bank: "BPA",
    accountNumber: "",
    phone: "",
    lastFour: "",
    balance: 0,
    currency: getBaseCurrency().code,
    isActive: true
  });

  const [transferData, setTransferData] = useState({
    fromCardId: "",
    toCardId: "",
    toExternalCard: "",
    toExternalName: "",
    isExternal: false,
    amount: 0,
    reason: ""
  });

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const bankCardById = useMemo(() => new Map(bankCards.map(card => [card.id, card])), [bankCards]);
  const filteredBankTransactions = useMemo(
    () => selectedCardId
      ? bankTransactions.filter(transaction => transaction.cardId === selectedCardId)
      : bankTransactions,
    [bankTransactions, selectedCardId]
  );
  const [cardToDelete, setCardToDelete] = useState<string | null>(null);
  const [movementToDelete, setMovementToDelete] = useState<BankTransaction | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanAccount = (formData.accountNumber || '').replace(/\s/g, '');
    const derivedLastFour = cleanAccount.length >= 4 ? cleanAccount.slice(-4) : (formData.lastFour || '');

    const cardPayload: Partial<BankCard> = {
      ...formData,
      balance: formData.balance !== undefined && Number.isFinite(Number(formData.balance))
        ? Number(formData.balance)
        : 0,
      accountNumber: cleanAccount,
      lastFour: derivedLastFour
    };

    if (editingCard) {
      updateBankCard(editingCard.id, cardPayload);
      addNotification(`Tarjeta ${editingCard.bank} actualizada.`, 'info');
    } else {
      addBankCard({
        id: generateId('CRD'),
        ...(cardPayload as BankCard)
      });
      addNotification(`Tarjeta ${formData.bank} creada exitosamente.`, 'success');
    }
    setShowAddModal(false);
    setEditingCard(null);
    setFormData({ name: "", bank: "BPA", accountNumber: "", phone: "", lastFour: "", balance: 0, currency: getBaseCurrency().code, isActive: true });
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const fromCard = bankCards.find(c => c.id === transferData.fromCardId);

    if (!fromCard || transferData.amount <= 0) return;

    const date = new Date().toISOString();
    const ref = generateId('TRF');

    if (transferData.isExternal) {
      if (fromCard.balance < transferData.amount) {
        addNotification('Saldo insuficiente en la cuenta de origen.', 'error');
        return;
      }
      const saved = await addBankTransaction({
        id: generateId('BTX'),
        cardId: fromCard.id,
        type: 'withdrawal',
        amount: transferData.amount,
        date,
        reference: ref,
        description: `Transferencia Externa a ${transferData.toExternalName} (${transferData.toExternalCard}): ${transferData.reason}`
      });
      if (!saved) return;
      addNotification(`Transferencia externa de ${transferData.amount} registrada.`, 'success');
    } else {
      const toCard = bankCards.find(c => c.id === transferData.toCardId);
      if (!toCard) return;
      if (fromCard.balance < transferData.amount) {
        addNotification('Saldo insuficiente en la cuenta de origen.', 'error');
        return;
      }

      let targetAmount = transferData.amount;
      if (fromCard.currency !== toCard.currency) {
        const currencies = useStore.getState().currencies;
        const fromRate = currencies.find(c => c.code === fromCard.currency)?.rateToBase || 1;
        const toRate = currencies.find(c => c.code === toCard.currency)?.rateToBase || 1;
        targetAmount = (transferData.amount * fromRate) / toRate;
      }

      const payload = {
        operationId: ref,
        fromCardId: fromCard.id,
        toCardId: toCard.id,
        amount: transferData.amount,
        targetAmount,
        date,
        reason: transferData.reason
      };
      const actionId = 'bank-transfer:' + ref;

      // Persist the intent before attempting the server call. If the response
      // is lost, the exact same operation is safely replayed on reconnect.
      await enqueueOfflineItem('bank_internal_transfer', payload, actionId);

      if (navigator.onLine) {
        try {
          const result = await callBankInternalTransferRPC(payload);
          if (!result.success) {
            const code = String((result as any).errorCode || '');
            const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
            if (permanentCodes.has(code)) {
              const queued = getOfflineQueue().find(item => item.type === 'bank_internal_transfer' && item.actionId === actionId);
              if (queued) await removeFromOfflineQueue(queued.id);
              throw new Error(result.error || 'La transferencia bancaria fue rechazada por el servidor');
            }

            // La petición pudo haber sido aplicada y solo se perdió la respuesta.
            // Conservamos la operación original, reflejamos el movimiento como
            // pendiente y evitamos que el usuario lo repita con otro operationId.
            useStore.setState(state => ({
              bankTransactions: [
                {
                  id: ref + ':IN', cardId: toCard.id, type: 'deposit',
                  amount: targetAmount, date, reference: ref, transactionId: ref,
                  description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
                },
                {
                  id: ref + ':OUT', cardId: fromCard.id, type: 'withdrawal',
                  amount: transferData.amount, date, reference: ref, transactionId: ref,
                  description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
                },
                ...(state.bankTransactions || []).filter(t => t.reference !== ref)
              ],
              bankCards: (state.bankCards || []).map(card => {
                if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
                if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
                return card;
              })
            }));
            addNotification('Transferencia bancaria guardada localmente y pendiente de confirmación con la nube.', 'info');
            setShowTransferModal(false);
            setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
            return;
          }

          const queued = getOfflineQueue().find(item => item.type === 'bank_internal_transfer' && item.actionId === actionId);
          if (queued) await removeFromOfflineQueue(queued.id);

          const fromBalance = Number(result.data?.from_balance);
          const toBalance = Number(result.data?.to_balance);
          const outTx: BankTransaction = {
            id: ref + ':OUT',
            cardId: fromCard.id,
            type: 'withdrawal',
            amount: transferData.amount,
            date,
            reference: ref,
            description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
          };
          const inTx: BankTransaction = {
            id: ref + ':IN',
            cardId: toCard.id,
            type: 'deposit',
            amount: targetAmount,
            date,
            reference: ref,
            description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
          };

          useStore.setState(state => ({
            bankTransactions: [inTx, outTx, ...(state.bankTransactions || []).filter(t => t.reference !== ref)],
            bankCards: (state.bankCards || []).map(card => {
              if (card.id === fromCard.id && Number.isFinite(fromBalance)) return { ...card, balance: fromBalance };
              if (card.id === toCard.id && Number.isFinite(toBalance)) return { ...card, balance: toBalance };
              return card;
            })
          }));
          addNotification(`Transferencia interna de ${transferData.amount} completada.`, 'success');
        } catch (err: any) {
          // Error de transporte: la operación ya está en la cola. El servidor
          // pudo haberla aplicado; reflejamos el mismo estado pendiente que en
          // una caída offline para que el usuario no genere una segunda operación.
          if (!(err?.message || '').includes('rechazada por el servidor')) {
            useStore.setState(state => ({
              bankTransactions: [
                {
                  id: ref + ':IN', cardId: toCard.id, type: 'deposit',
                  amount: targetAmount, date, reference: ref, transactionId: ref,
                  description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
                },
                {
                  id: ref + ':OUT', cardId: fromCard.id, type: 'withdrawal',
                  amount: transferData.amount, date, reference: ref, transactionId: ref,
                  description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
                },
                ...(state.bankTransactions || []).filter(t => t.reference !== ref)
              ],
              bankCards: (state.bankCards || []).map(card => {
                if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
                if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
                return card;
              })
            }));
            addNotification('No se pudo confirmar la respuesta. La transferencia quedó pendiente y no debes repetirla.', 'info');
            setShowTransferModal(false);
            setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
            return;
          }
          addNotification(err?.message || 'La transferencia quedó pendiente de sincronización.', 'error');
          return;
        }
      } else {
        // Offline fallback keeps both ledger entries durable. They are replayed
        // independently, while the internal RPC is used whenever connectivity
        // returns for online-originated transfers.
        await enqueueOfflineItem(
          'bank_internal_transfer',
          payload,
          actionId
        );
        useStore.setState(state => ({
          bankTransactions: [
            {
              id: ref + ':IN',
              cardId: toCard.id,
              type: 'deposit',
              amount: targetAmount,
              date,
              reference: ref,
              transactionId: ref,
              description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
            },
            {
              id: ref + ':OUT',
              cardId: fromCard.id,
              type: 'withdrawal',
              amount: transferData.amount,
              date,
              reference: ref,
              transactionId: ref,
              description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
            },
            ...(state.bankTransactions || []).filter(t => t.reference !== ref)
          ],
          bankCards: (state.bankCards || []).map(card => {
            if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
            if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
            return card;
          })
        }));
        addNotification('Transferencia guardada offline; se sincronizará al reconectar.', 'info');
      }
    }

    setShowTransferModal(false);
    setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
  };

  const handleReconcile = async () => {
    setIsReconciling(true);
    try {
      const res = await reconcileBankBalances();
      addNotification(res.message, 'success');
    } catch (err) {
      addNotification("Error al reconciliar con la base de datos.", 'error');
    } finally {
      setIsReconciling(false);
    }
  };

  const handleConfirmDeleteMovement = async () => {
    if (!movementToDelete) return;
    const deleted = await deleteBankTransaction(movementToDelete.id);
    if (!deleted) return;
    addNotification(`Movimiento ${movementToDelete.reference || movementToDelete.id} eliminado y saldo de tarjeta ajustado correctamente.`, 'info');
    setMovementToDelete(null);
  };

  const filteredTransactions = filteredBankTransactions
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-3 animate-in fade-in duration-300">
      {/* Delete Card Confirmation Modal */}
      {cardToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-2xl max-w-xs w-full text-center border border-base animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-rose-50 dark:bg-rose-950/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6 text-rose-600 dark:text-rose-400" />
            </div>
            <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">¿Eliminar Tarjeta?</h3>
            <p className="text-[10px] font-bold text-muted mb-4">Esta acción no se puede deshacer y eliminará el registro de la cuenta.</p>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setCardToDelete(null)}
                className="py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl font-black text-[9px] uppercase tracking-wider cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={async () => {
                  const id = cardToDelete;
                  const deleted = await deleteBankCard(id);
                  if (!deleted) return;
                  setCardToDelete(null);
                  if (selectedCardId === id) setSelectedCardId(null);
                  addNotification("Tarjeta eliminada correctamente.", 'info');
                }}
                className="py-2 bg-rose-600 text-white rounded-xl font-black text-[9px] uppercase tracking-wider shadow-lg shadow-rose-200 dark:shadow-none cursor-pointer"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Movement Confirmation Modal */}
      {movementToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-2xl max-w-xs w-full text-center border border-base animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-rose-50 dark:bg-rose-950/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6 text-rose-600 dark:text-rose-400" />
            </div>
            <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">¿Eliminar Movimiento?</h3>
            <p className="text-[10px] font-bold text-muted mb-2">
              Monto: <strong className="text-primary">${movementToDelete.amount.toLocaleString()}</strong> ({movementToDelete.type})
            </p>
            <p className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-2 rounded-xl mb-4">
              {movementToDelete.type === 'deposit' || movementToDelete.type === 'payment_received' 
                ? '⚠️ Este monto será descontado del saldo actual de la tarjeta.' 
                : '⚠️ Este monto será devuelto al saldo de la tarjeta.'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setMovementToDelete(null)}
                className="py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl font-black text-[9px] uppercase tracking-wider cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={handleConfirmDeleteMovement}
                className="py-2 bg-rose-600 text-white rounded-xl font-black text-[10px] uppercase tracking-wider shadow-lg shadow-rose-200 dark:shadow-none cursor-pointer"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 px-1">
        <div className="flex items-center gap-2">
          <h1 data-palmi-content="banks" className="text-base sm:text-lg font-black text-primary tracking-tight uppercase">Cuentas Bancarias</h1>
          <InfoTooltip text="Gestiona tus cuentas bancarias, tarjetas y transferencias. Reconcilia con la base de datos en Supabase y mantén el control exacto de tus saldos." position="bottom" />
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleReconcile}
            disabled={isReconciling}
            title="Buscar datos en Supabase, comparar y reconciliar saldos y ventas"
            className="bg-secondary border border-base text-primary hover:bg-subtle px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isReconciling ? (
              <RefreshCw size={13} className="animate-spin text-indigo-500" />
            ) : (
              <ShieldCheck size={13} className="text-emerald-500" />
            )}
            <span>{isReconciling ? "Sincronizando..." : "Reconciliar con Base de Datos"}</span>
          </button>

          <button
            onClick={() => { 
              setEditingCard(null); 
              setFormData({ name: "", bank: "BPA", lastFour: "", balance: 0, currency: getBaseCurrency().code, isActive: true }); 
              setShowAddModal(true); 
            }}
            className="bg-indigo-600 text-white px-3 py-1.5 rounded-xl font-black text-[9px] uppercase tracking-wider hover:bg-indigo-700 transition-all shadow-md active:scale-95 flex items-center gap-1.5 cursor-pointer"
          >
            <Plus size={13} /> Nueva Cuenta
          </button>
        </div>
      </div>

      {/* Bank Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
        {bankCards.map(card => (
          <div key={card.id} onClick={() => setSelectedCardId(card.id)} className={`relative overflow-hidden rounded-xl p-2 sm:p-2.5 cursor-pointer transition-all duration-300 ${selectedCardId === card.id ? 'ring-2 ring-indigo-500 shadow-md scale-[1.01]' : 'hover:shadow-xs hover:-translate-y-0.5'} bg-gradient-to-br from-slate-800 to-slate-900 text-white min-h-[85px] flex flex-col justify-between`}>
             {/* Background Pattern */}
             <div className="absolute top-0 right-0 -mr-4 -mt-4 w-12 h-12 rounded-full bg-white opacity-5"></div>
             
             <div className="flex justify-between items-start mb-1 relative z-10">
               <div>
                 <h3 className="text-[7.5px] font-black uppercase tracking-wider opacity-80">{card.bank}</h3>
               </div>
               <div className="flex gap-1 items-center">
                 <button onClick={(e) => { e.stopPropagation(); setEditingCard(card); setFormData(card); setShowAddModal(true); }} className="text-white opacity-70 hover:opacity-100 transition-opacity text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 inline-flex items-center cursor-pointer">Editar</button>
                 <button onClick={(e) => { e.stopPropagation(); setTransferData({...transferData, fromCardId: card.id}); setShowTransferModal(true); }} className="text-emerald-300 hover:text-emerald-200 transition-colors text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 inline-flex items-center cursor-pointer">Transferir</button>
                 <button onClick={(e) => { e.stopPropagation(); setCardToDelete(card.id); }} className="text-rose-300 hover:text-rose-200 transition-colors text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 inline-flex items-center cursor-pointer">Eliminar</button>
               </div>
             </div>
             
             <div className="mb-1 relative z-10 flex items-center justify-between">
               <div className="w-4 h-3 bg-gradient-to-br from-amber-300 to-amber-500 rounded-xs opacity-90 shadow-xs"></div>
               <p className="font-mono text-[10px] sm:text-[11px] tracking-wider opacity-90 text-slate-100">
                 •••• {card.lastFour || 'XXXX'}
               </p>
             </div>
             
             <div className="flex justify-between items-end relative z-10">
               <div className="min-w-0">
                 <p className="text-[6px] font-black uppercase tracking-widest opacity-50 truncate">{card.name}</p>
                 <p className="text-[7.5px] font-bold tracking-tight uppercase truncate">{card.currency}</p>
               </div>
               <div className="text-right">
                 <p className="text-[10px] sm:text-[11px] font-black leading-none">{card.balance.toLocaleString()}</p>
               </div>
             </div>
          </div>
        ))}

        <button
          onClick={() => { setEditingCard(null); setFormData({ name: "", bank: "BPA", lastFour: "", balance: 0, currency: getBaseCurrency().code, isActive: true }); setShowAddModal(true); }}
          className="rounded-xl p-2 sm:p-2.5 border-2 border-dashed border-base hover:border-indigo-500 bg-secondary/60 hover:bg-subtle flex flex-col items-center justify-center gap-1 transition-all group min-h-[85px] cursor-pointer"
        >
          <div className="w-5 h-5 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center group-hover:scale-110 transition-transform">
            <Plus size={12} />
          </div>
          <span className="text-[7.5px] font-black text-primary uppercase tracking-wider">Agregar Cuenta</span>
        </button>
      </div>

      {/* Movements Table */}
      <div className="bg-secondary rounded-xl border border-base overflow-hidden">
        <div className="p-2.5 sm:p-3 border-b border-base flex justify-between items-center bg-secondary">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-secondary border border-base text-primary rounded-lg flex items-center justify-center">
              <Activity size={12} />
            </div>
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-tight">Movimientos Bancarios</h3>
              <p className="text-[7.5px] font-bold text-muted uppercase">{selectedCardId ? 'Filtrado por Tarjeta' : 'Todos los Movimientos'}</p>
            </div>
          </div>
          {selectedCardId && (
            <button onClick={() => setSelectedCardId(null)} className="text-[7.5px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded-md cursor-pointer">
              Ver Todas
            </button>
          )}
        </div>
        
        {filteredTransactions.length === 0 ? (
          <div className="p-6 text-center">
            <div className="w-10 h-10 bg-secondary border border-base rounded-full flex items-center justify-center mx-auto mb-2 text-muted">
              <List size={18} />
            </div>
            <h4 className="text-xs font-black text-primary mb-0.5">No hay movimientos</h4>
            <p className="text-[10px] font-bold text-muted">Las transferencias y pagos confirmados aparecerán aquí</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-secondary border-b border-base">
                <tr>
                  <th className="px-2.5 py-1.5 text-left text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Fecha</th>
                  <th className="px-2.5 py-1.5 text-left text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Cuenta</th>
                  <th className="px-2.5 py-1.5 text-left text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Tipo</th>
                  <th className="px-2.5 py-1.5 text-left text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Referencia</th>
                  <th className="px-2.5 py-1.5 text-left text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Descripción</th>
                  <th className="px-2.5 py-1.5 text-right text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Monto</th>
                  <th className="px-2.5 py-1.5 text-center text-[7.5px] sm:text-[8px] font-black text-muted uppercase tracking-wider">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {filteredTransactions.map(t => {
                  const card = bankCardById.get(t.cardId);
                  const isIncome = t.type === 'deposit' || t.type === 'payment_received';
                  return (
                    <tr key={t.id} className="hover:bg-subtle/50 transition-colors">
                      <td className="px-2.5 py-1.5 text-[9px] font-bold text-secondary">{new Date(t.date).toLocaleString()}</td>
                      <td className="px-2.5 py-1.5 text-[9px] font-black text-primary">{card?.name || card?.bankName || card?.bank || 'Desconocida'} (****{card?.lastFour})</td>
                      <td className="px-2.5 py-1.5">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[7.5px] font-black uppercase tracking-wider ${isIncome ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400'}`}>
                          {isIncome ? <ArrowDownRight size={8} /> : <ArrowUpRight size={8} />}
                          {(t.type || '').replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-[8.5px] font-mono font-bold text-slate-500 uppercase">{t.reference || 'N/A'}</td>
                      <td className="px-2.5 py-1.5 text-[9px] font-bold text-muted truncate max-w-[200px]">{t.description}</td>
                      <td className={`px-2.5 py-1.5 text-[9px] font-black text-right ${isIncome ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {isIncome ? '+' : '-'}${t.amount.toLocaleString()}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <button
                          onClick={() => setMovementToDelete(t)}
                          title="Eliminar este movimiento bancario y ajustar saldo"
                          className="p-1 hover:bg-rose-50 dark:hover:bg-rose-950/50 text-slate-400 hover:text-rose-600 rounded-lg transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal Agregar / Editar Tarjeta */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-3">
          <div className="bg-secondary rounded-2xl w-full max-w-xs sm:max-w-sm overflow-hidden shadow-2xl border border-base animate-in zoom-in-95 duration-200">
            <div className="px-3.5 py-2.5 border-b border-base flex justify-between items-center bg-subtle">
              <h2 className="text-xs font-black text-primary uppercase tracking-tight">{editingCard ? 'Editar Cuenta' : 'Nueva Cuenta'}</h2>
              <button onClick={() => setShowAddModal(false)} className="text-muted hover:text-primary font-bold text-xs p-1 cursor-pointer">✕</button>
            </div>
            
            <form onSubmit={handleSave} className="p-3 space-y-2.5">
              <div>
                <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Nombre o Titular</label>
                <input 
                  type="text" 
                  required
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  placeholder="Ej: Titular"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Banco</label>
                  <select
                    value={formData.bank}
                    onChange={e => setFormData({...formData, bank: e.target.value})}
                    className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  >
                    <option value="BPA">BPA</option>
                    <option value="BANDEC">BANDEC</option>
                    <option value="Banco Metropolitano">Banco Metropolitano</option>
                    <option value="EnZona">EnZona</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Teléfono</label>
                  <input 
                    type="text" 
                    placeholder="Ej: 535..."
                    value={formData.phone || ''}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                    className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Número de Tarjeta (16 dígitos)</label>
                <input 
                  type="text" 
                  maxLength={19}
                  placeholder="9202 xxxx xxxx xxxx"
                  value={formData.accountNumber || ''}
                  onChange={e => {
                    const raw = e.target.value.replace(/\D/g, '').slice(0, 16);
                    const formatted = raw.replace(/(\d{4})(?=\d)/g, '$1 ');
                    setFormData({
                      ...formData,
                      accountNumber: formatted,
                    });
                  }}
                  className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold font-mono text-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Saldo Inicial</label>
                  <input 
                    type="number" 
                    required
                    value={formData.balance}
                    onChange={e => setFormData({...formData, balance: Number(e.target.value)})}
                    className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  />
                </div>
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Moneda</label>
                  <select
                    value={formData.currency}
                    onChange={e => setFormData({...formData, currency: e.target.value})}
                    className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  >
                    {useStore.getState().currencies.map(c => (
                      <option key={c.code} value={c.code}>{c.code}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-1.5">
                <button type="submit" className="w-full bg-indigo-600 text-white py-2 rounded-xl font-black text-[10px] uppercase tracking-wider hover:bg-indigo-700 transition-all shadow-md shadow-indigo-600/20 active:scale-98 cursor-pointer">
                  {editingCard ? 'Guardar Cambios' : 'Crear Cuenta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Transferencia entre Tarjetas */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-3">
          <div className="bg-secondary rounded-2xl w-full max-w-xs sm:max-w-sm overflow-hidden shadow-2xl border border-base animate-in zoom-in-95 duration-200">
            <div className="px-3.5 py-2.5 border-b border-base flex justify-between items-center bg-subtle">
              <h2 className="text-xs font-black text-primary uppercase tracking-tight">Transferencia</h2>
              <button onClick={() => setShowTransferModal(false)} className="text-muted hover:text-primary font-bold text-xs p-1 cursor-pointer">✕</button>
            </div>
            
            <form onSubmit={handleTransfer} className="p-3 space-y-2.5">
              <div className="flex bg-subtle p-0.5 rounded-lg border border-base">
                <button
                  type="button"
                  onClick={() => setTransferData({...transferData, isExternal: false})}
                  className={cn(
                    "flex-1 py-1 text-[8px] font-black uppercase tracking-wider rounded transition-all cursor-pointer",
                    !transferData.isExternal ? "bg-primary text-indigo-600 shadow-xs" : "text-muted hover:text-primary"
                  )}
                >
                  Interna
                </button>
                <button
                  type="button"
                  onClick={() => setTransferData({...transferData, isExternal: true})}
                  className={cn(
                    "flex-1 py-1 text-[8px] font-black uppercase tracking-wider rounded transition-all cursor-pointer",
                    transferData.isExternal ? "bg-primary text-indigo-600 shadow-xs" : "text-muted hover:text-primary"
                  )}
                >
                  Externa
                </button>
              </div>

              <div>
                <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Desde</label>
                <select 
                  required
                  value={transferData.fromCardId}
                  onChange={e => setTransferData({...transferData, fromCardId: e.target.value})}
                  className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                >
                  <option value="">Seleccionar origen</option>
                  {bankCards.map(c => (
                    <option key={c.id} value={c.id}>{c.bank} - ****{c.lastFour} ({c.balance.toLocaleString()} {c.currency})</option>
                  ))}
                </select>
              </div>

              {!transferData.isExternal ? (
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Hacia</label>
                  <select 
                    required
                    value={transferData.toCardId}
                    onChange={e => setTransferData({...transferData, toCardId: e.target.value})}
                    className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  >
                    <option value="">Seleccionar destino</option>
                    {bankCards.filter(c => c.id !== transferData.fromCardId).map(c => (
                      <option key={c.id} value={c.id}>{c.bank} - ****{c.lastFour} ({c.currency})</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-2">
                  <div>
                    <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Tarjeta Destino</label>
                    <input 
                      type="text" 
                      required
                      value={transferData.toExternalCard}
                      onChange={e => setTransferData({...transferData, toExternalCard: e.target.value})}
                      className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                      placeholder="9202 XXXX XXXX XXXX"
                    />
                  </div>
                  <div>
                    <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Nombre Destinatario</label>
                    <input 
                      type="text" 
                      required
                      value={transferData.toExternalName}
                      onChange={e => setTransferData({...transferData, toExternalName: e.target.value})}
                      className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                      placeholder="Ej: Juan Pérez"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Monto</label>
                <input 
                  type="number" 
                  required
                  min="0.01"
                  step="0.01"
                  value={transferData.amount || ''}
                  onChange={e => setTransferData({...transferData, amount: parseFloat(e.target.value) || 0})}
                  className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-[8px] font-black text-muted uppercase tracking-wider mb-1">Motivo</label>
                <input 
                  type="text" 
                  required
                  value={transferData.reason}
                  onChange={e => setTransferData({...transferData, reason: e.target.value})}
                  className="w-full px-2.5 py-1.5 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-[11px] font-bold text-primary"
                  placeholder="Ej: Reabastecimiento"
                />
              </div>

              <div className="pt-1.5">
                <button type="submit" className="w-full bg-emerald-600 text-white py-2 rounded-xl font-black text-[10px] uppercase tracking-wider hover:bg-emerald-700 transition-all shadow-md shadow-emerald-600/20 active:scale-98 cursor-pointer">
                  Transferir Ahora
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

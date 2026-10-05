import { getSupabase } from '../../lib/supabase';
import { getActiveTenant } from '../tenant';
import { enqueueOfflineItem } from '../offlineQueue';
import type { BankCard, BankTransaction } from '../../types';

async function onlineClient() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('offline');
  return supabase;
}

const queue = (type: Parameters<typeof enqueueOfflineItem>[0], data: unknown, id: string) =>
  enqueueOfflineItem(type, data, id);

export async function pushBankTransactionToSupabase(tx: BankTransaction) {
  try {
    const { callProcessBankTransactionRPC } = await import('./rpc');
    const res = await callProcessBankTransactionRPC({
      id: tx.id,
      cardId: tx.cardId,
      type: tx.type,
      amount: Number(tx.amount) || 0,
      date: tx.date,
      reference: tx.reference,
      description: tx.description,
      transactionId: tx.transactionId
    });
    if (!res.success) throw new Error(res.error || 'No se pudo registrar el movimiento bancario.');
    return true;
  } catch {
    await queue('bank_transaction', tx, tx.id);
    return false;
  }
}

export async function deleteBankTransactionFromSupabase(id: string) {
  try {
    const supabase = await onlineClient();
    const { companyId } = await getActiveTenant();
    const { error } = await supabase.from('bank_transactions').delete().eq('id', id).eq('company_id', companyId);
    if (error) throw error;
  } catch {}
}

export async function pushBankCardToSupabase(card: BankCard) {
  try {
    const supabase = await onlineClient();
    const { companyId } = await getActiveTenant();
    const { error } = await supabase.from('bank_accounts').upsert({
      id: card.id,
      company_id: companyId,
      name: card.name || card.bankName || 'Cuenta bancaria',
      bank_name: card.bankName || card.bank || 'Banco',
      last_four: (card.lastFour || card.lastFourDigits || '').slice(-4),
      currency_code: card.currency || 'USD',
      balance: Number(card.balance) || 0,
      active: card.isActive !== false,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch {
    await queue('bank_card', card, card.id);
    return false;
  }
}

export async function setBankCardBalanceToSupabase(cardId: string, expectedBalance: number, newBalance: number): Promise<boolean> {
  try {
    const supabase = await onlineClient();
    const { companyId } = await getActiveTenant();
    const { data, error } = await supabase.from('bank_accounts')
      .update({ balance: Number(newBalance) || 0, updated_at: new Date().toISOString() })
      .eq('id', cardId)
      .eq('company_id', companyId)
      .eq('balance', Number(expectedBalance) || 0)
      .select('id');
    if (error) throw error;
    return Boolean(data?.length);
  } catch {
    return false;
  }
}

export async function updateBankCardMetadataToSupabase(card: BankCard): Promise<boolean> {
  return pushBankCardToSupabase(card);
}

export async function deleteBankCardFromSupabase(id: string) {
  try {
    const supabase = await onlineClient();
    const { companyId } = await getActiveTenant();
    const { error } = await supabase.from('bank_accounts')
      .update({ active: false })
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw error;
  } catch {}
}

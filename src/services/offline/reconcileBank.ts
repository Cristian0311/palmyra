import { useStore } from '../../store/useStore';
import { pullBankDataFromSupabase } from '../supabaseSync';

export async function reconcileBankCanonical(): Promise<void> {
  try {
    const remote = await pullBankDataFromSupabase();
    if (remote.success) {
      useStore.setState({
        bankCards: remote.bankCards,
        bankTransactions: remote.bankTransactions
      });
    }
  } catch (error) {
    console.warn('[bank] No se pudo reconciliar el estado bancario canónico:', error);
  }
}

import { getSupabase } from '../lib/supabase';
import { describeNetworkError, fetchWithTimeout } from '../lib/http';

// El resumen lo genera un modelo: 30 s es margen suficiente incluso con la
// instancia despertando. Sin reintento a propósito: repetir el POST duplicaría
// el consumo de IA y el usuario ya recibe un mensaje claro.
const AI_SUMMARY_TIMEOUT_MS = 30_000;

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = (await getSupabase()?.auth.getSession()) || { data: { session: null } };
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export async function getBusinessSummaryAI(data: {
  salesToday: number;
  txCountToday: number;
  lowStockCount: number;
  topCategories: { name: string; value: number }[];
  baseCurrency: string;
}) {
  try {
    // /api/ai-* exige sesión en el servidor: sin la cabecera, el resumen
    // respondía 401 y la tarjeta mostraba un error genérico siempre.
    const response = await fetchWithTimeout(`${import.meta.env.VITE_API_URL || ''}/api/ai-business-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      body: JSON.stringify(data),
    }, AI_SUMMARY_TIMEOUT_MS);

    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();

    if (!response.ok) {
      console.error('AI Error: HTTP', response.status, raw.slice(0, 500));
      return 'No se pudo generar el análisis por IA en este momento.';
    }

    if (!contentType.toLowerCase().includes('application/json')) {
      console.error('AI Error: respuesta no JSON', raw.slice(0, 500));
      return 'El servicio de análisis por IA no está disponible todavía.';
    }

    let result: { success?: boolean; summary?: string; error?: string };
    try {
      result = JSON.parse(raw);
    } catch (parseError) {
      console.error('AI Error: JSON inválido', parseError);
      return 'El servicio de análisis por IA devolvió una respuesta inválida.';
    }

    if (result.success) {
      return result.summary || 'Análisis de IA completado sin resumen.';
    }

    console.error('AI Error:', result.error);
    return 'No se pudo generar el análisis por IA en este momento.';
  } catch (error) {
    console.error('AI Error:', error);
    return describeNetworkError(error);
  }
}

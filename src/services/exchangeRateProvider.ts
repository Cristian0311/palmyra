import { parseExchangeRates, type ExchangePayload } from '../lib/exchangeRates';

type Result = { status: number; body: ExchangePayload | { provider: 'eltoque'; source: 'elTOQUE API'; configured: boolean; error: string } };

export function createExchangeRateProvider(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: ExchangePayload | null = null;
  let pending: Promise<Result> | null = null;
  const failure = (configured: boolean, status: number, error: string): Result => cached
    ? { status: 200, body: { ...cached, stale: true, notice: `${error} Se conserva la última consulta; no es una tasa en vivo.` } }
    : { status, body: { provider: 'eltoque', source: 'elTOQUE API', configured, error } };

  async function request(token: string): Promise<Result> {
    if (!token.trim()) return failure(false, 503, 'Falta configurar la credencial de elTOQUE en el servidor. No se sustituyen sus tasas por las de otra fuente.');
    try {
      const response = await fetcher('https://tasas.eltoque.com/v1/trmi', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'elTOQUE rechazó la credencial del servidor; debe revisarse su vigencia.'
          : response.status === 429 ? 'elTOQUE ha limitado temporalmente las consultas.' : 'elTOQUE no está disponible en este momento.';
        return failure(true, 502, message);
      }
      const data: unknown = await response.json();
      if (!parseExchangeRates(data).length) return failure(true, 502, 'elTOQUE respondió sin cotizaciones válidas. No se muestran valores calculados ni inventados.');
      cached = { provider: 'eltoque', source: 'elTOQUE API', market: 'informal', capturedAt: new Date(now()).toISOString(), data };
      return { status: 200, body: cached };
    } catch (error) {
      return failure(true, 502, error instanceof Error && error.name === 'TimeoutError'
        ? 'La consulta a elTOQUE agotó el tiempo de espera.' : 'No fue posible conectar con elTOQUE. Revisa la conexión.');
    }
  }

  return (token: string): Promise<Result> => {
    if (cached && now() - Date.parse(cached.capturedAt) < 5 * 60 * 1000) return Promise.resolve({ status: 200, body: cached });
    if (!pending) pending = request(token).finally(() => { pending = null; });
    return pending;
  };
}

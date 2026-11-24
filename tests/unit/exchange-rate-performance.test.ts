import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_RATE_MIN_GAP_MS } from "../../src/services/autoExchangeRate";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const MINUTE = 60 * 1000;

test("la página de tasas consulta la fuente cada 20 minutos", () => {
  const page = read("src/pages/ExchangeRate.tsx");
  assert.match(page, /const REFRESH_MS = 20 \* 60 \* 1000/);
  assert.match(page, /La tasa se consulta automáticamente cada 20 minutos/);
});

test("la sincronización automática no repite ciclos antes de 20 minutos", () => {
  assert.equal(AUTO_RATE_MIN_GAP_MS, 20 * MINUTE);
});

test("seleccionar moneda no re-filtra el historial por tarjeta: series precalculadas, formateadores reutilizados y tarjetas memoizadas", () => {
  const page = read("src/pages/ExchangeRate.tsx");
  // Una sola pasada por (historial, período) construye todas las series.
  assert.match(page, /const seriesByCode = useMemo/);
  // Los deltas se precalculan por código en lugar de por tarjeta y por render.
  assert.match(page, /const deltasByCode = useMemo/);
  // Las tarjetas solo se repintan cuando cambian sus props.
  assert.match(page, /const RateCard = memo\(/);
  // Los `Intl.*` se construyen UNA sola vez (2 números + 2 fechas) y no por
  // punto del historial: era la causa del trabe al cambiar de moneda.
  assert.equal(page.match(/new Intl\.(NumberFormat|DateTimeFormat)/g)?.length ?? 0, 4);
  // El gráfico grande y las mini-gráficas se deciman.
  assert.match(page, /const CHART_MAX_POINTS = 320/);
  assert.match(page, /const SPARK_MAX_POINTS = 120/);
  assert.match(page, /decimateSeries\(chart, CHART_MAX_POINTS\)/);
  // La tabla de consultas solo se renderiza abierta y acotada.
  assert.match(page, /historyOpen/);
  assert.match(page, /const HISTORY_TABLE_MAX_ROWS = 1000/);
  // El historial verificado del servidor se sigue consultando por período.
  assert.match(page, /rpc\('get_verified_exchange_rate_history'/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

// La zona del equipo no debe influir: un día de negocio es un calendario puro.
// Se fija antes de importar los helpers para que cualquier `Date` interno use
// un offset positivo (Asia) y no pueda "correr" la fecha hacia atrás.
process.env.TZ = 'Asia/Tokyo';

const { filterReportTransactions, summarizeReportSales } = await import(
  '../../src/modules/reports/utils/reportSalesSummary'
);
const { saleBusinessDateYMD, matchesReportSaleDateFilter } = await import(
  '../../src/modules/reports/utils/reportDateFilter'
);
const { formatBusinessDateLabel, normalizeBusinessDateYMD, getLocalDateYMD } = await import(
  '../../src/utils/dateUtils'
);

type SaleLike = {
  id: string;
  businessDate?: string;
  date: string;
  total: number;
  items: any[];
  status: 'completed';
  branchId: string;
  userId: string;
  payments: any[];
};

function sale(id: string, date: string, businessDate: string | undefined, total: number): SaleLike {
  return {
    id,
    date,
    businessDate,
    total,
    status: 'completed',
    branchId: 'w1',
    userId: 'u1',
    payments: [],
    items: [{ product: { id: `p-${id}`, name: `Producto ${id}` }, quantity: 1, price: total, total }],
  };
}

// Venta registrada hoy (11-20) pero con fecha de negocio 5 días antes (11-15).
const ventaConFechaAnterior = sale('t-15', '2026-11-20T15:30:00.000Z', '2026-11-15', 100);
// Otra venta del mismo día de negocio, registrada en esa fecha.
const ventaLegacy = sale('t-legacy', '2026-11-15T15:00:00.000Z', undefined, 50);
// Venta de hoy sin fecha de negocio distinta: se queda en hoy.
const ventaDeHoy = sale('t-hoy', '2026-11-20T16:10:00.000Z', '2026-11-20', 30);

const ventas = [ventaConFechaAnterior, ventaLegacy, ventaDeHoy] as any[];
const ahora = new Date('2026-11-20T18:00:00.000Z');

function escenario() {
  const filtroDia15 = filterReportTransactions(ventas, {
    branchId: 'all', workerId: 'all', date: '2026-11-15', period: 'custom',
  }, ahora);
  const filtroHoy = filterReportTransactions(ventas, {
    branchId: 'all', workerId: 'all', date: '', period: 'today',
  }, ahora);
  return {
    filtroDia15: filtroDia15.map(tx => tx.id).sort(),
    filtroHoy: filtroHoy.map(tx => tx.id).sort(),
    resumenDia15: summarizeReportSales(filtroDia15, []),
    diaNegocio: saleBusinessDateYMD(ventaConFechaAnterior),
    etiqueta: formatBusinessDateLabel(saleBusinessDateYMD(ventaConFechaAnterior)),
  };
}

test('la fecha de negocio elegida agrupa la venta en el día anterior, no en el de creación', () => {
  const r = escenario();
  assert.deepEqual(r.filtroDia15, ['t-15', 't-legacy']);
  assert.equal(r.resumenDia15.total, 150);
  assert.equal(r.resumenDia15.tickets, 2);
  assert.equal(r.diaNegocio, '2026-11-15');
  assert.equal(r.etiqueta, '15/11/2026');
});

test('el filtro "Hoy" no se lleva una venta creada hoy cuya fecha de negocio es anterior', () => {
  const r = escenario();
  assert.deepEqual(r.filtroHoy, ['t-hoy']);
  assert.equal(r.resumenDia15.sales.some(tx => tx.id === 't-15'), true);
});

test('la fecha de negocio no se desplaza al cambiar la zona horaria del equipo', () => {
  const anterior = escenario();
  const zonaOriginal = process.env.TZ;
  try {
    process.env.TZ = 'America/Havana';
    const cuba = escenario();
    process.env.TZ = 'Asia/Kolkata';
    const india = escenario();
    for (const corrida of [cuba, india]) {
      assert.deepEqual(corrida.filtroDia15, anterior.filtroDia15);
      assert.deepEqual(corrida.filtroHoy, anterior.filtroHoy);
      assert.equal(corrida.diaNegocio, '2026-11-15');
      assert.equal(corrida.etiqueta, '15/11/2026');
      assert.equal(corrida.resumenDia15.total, 150);
    }
  } finally {
    process.env.TZ = zonaOriginal;
  }
});

test('las ventas antiguas sin fecha de negocio siguen agrupándose por su creación', () => {
  const legacy = normalizeBusinessDateYMD(undefined) ?? getLocalDateYMD(ventaLegacy.date);
  assert.equal(legacy, '2026-11-15');
  assert.equal(saleBusinessDateYMD(ventaLegacy), '2026-11-15');
  assert.equal(
    matchesReportSaleDateFilter(ventaLegacy, '2026-11-15', 'custom', ahora),
    true,
  );
  assert.equal(normalizeBusinessDateYMD('2026-02-30'), undefined);
  assert.equal(normalizeBusinessDateYMD('2026-11-25'), '2026-11-25');
});

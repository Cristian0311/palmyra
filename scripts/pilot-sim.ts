/**
 * Simulación pura del piloto F7 de PALMYRA (5 equipos, 28 días).
 *
 * No hay temporizadores ni red: dados (días, equipos, topología, semilla) el
 * modelo decide cuántas solicitudes a la nube consume cada equipo cada día y
 * comprueba los presupuestos aprobados:
 *   - topología hub: el negocio entero gasta <100 solicitudes/día en la nube;
 *   - topología directa: un equipo <100/día y cinco equipos <500/día;
 *   - restauración estimada por debajo de 15 minutos.
 *
 * Reglas del modelo (las mismas que la implementación real):
 *   - push: una solicitud por ciclo de 15 min con filas pendientes (tope 96/día);
 *     los lotes se agrupan de 2 en 2 ventas, así que el volumen manda;
 *   - pull: una solicitud por ciclo de 30 min (tope 48/día);
 *   - bootstrap: 34 solicitudes repartidas en los 3 primeros días EN LÍNEA
 *     (12/11/11); si el equipo arranca sin internet, se difiere;
 *   - lease: 2/día; tasas: 1 por ciclo de 90 min (8/día, tope 48);
 *   - avisos de plan: 1/día (despreciable);
 *   - los días sin internet no gastan ni una solicitud a la nube: las filas se
 *     acumulan y se vacían en el mismo lote al reconectar (nada se pierde);
 *   - en hub, los clientes LAN no hablan con la nube: su tráfico es LAN.
 *
 * Todo es determinista: `simulatePilot({ seed })` devuelve siempre lo mismo.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PilotTopology = "hub" | "direct";
export type PilotDeviceKind = "pc" | "phone" | "tablet";

export interface PilotDeviceSpec {
  id: string;
  label: string;
  kind: PilotDeviceKind;
  /** Ventas que registra el equipo en un día completo. */
  salesPerDay: number;
  /** Día (1-based) en el que el equipo entra al piloto. */
  onlineFromDay?: number;
}

export interface PilotOptions {
  /** Días simulados (28 por defecto). */
  days?: number;
  /** Equipos del negocio (5 por defecto: 2 PC, 2 móviles y 1 tablet). */
  devices?: number;
  /** Topología: hub (un syncer a la nube) o directa (cada equipo a la nube). */
  topology?: PilotTopology;
  /** Semilla del PRNG determinista. */
  seed?: number;
  /** Días (1-based) sin internet en todo el negocio. */
  offlineDays?: number[];
  /** Equipo que actúa de syncer en la topología hub. */
  hubDeviceId?: string;
  /** Probabilidad de edición en conflicto por equipo y día. */
  conflictRate?: number;
  /** Rendimiento de restauración en MB/minuto. */
  restoreThroughputMbPerMin?: number;
  /** Minutos fijos de una restauración (verificación y arranque). */
  restoreOverheadMin?: number;
  /** Equipos explícitos; si se pasan, mandan sobre `devices`. */
  deviceSpecs?: PilotDeviceSpec[];
}

export interface PilotDeviceDay {
  day: number;
  deviceId: string;
  /** Enlace a la nube disponible (la LAN puede seguir viva sin internet). */
  online: boolean;
  sales: number;
  push: number;
  pull: number;
  bootstrap: number;
  lease: number;
  rates: number;
  plan: number;
  cloudRequests: number;
  lanRequests: number;
  syncCycles: number;
  conflicts: number;
  /** Filas propias esperando subir (solo crece sin internet). */
  backlogRows: number;
}

export interface PilotPeak {
  day: number;
  requests: number;
}

export interface PilotDeviceSummary {
  deviceId: string;
  label: string;
  kind: PilotDeviceKind;
  /** true si este equipo es el que habla con la nube. */
  cloudSyncer: boolean;
  days: PilotDeviceDay[];
  totalCloud: number;
  totalLan: number;
  averagePerDay: number;
  peakDay: PilotPeak | null;
  sales: number;
  conflicts: number;
  syncCycles: number;
  offlineDays: number;
  bootstrapRequests: number;
}

export interface PilotDailyTotals {
  day: number;
  cloudRequests: number;
  lanRequests: number;
  sales: number;
  conflicts: number;
  online: boolean;
}

export interface PilotRestoreEstimate {
  rows: number;
  dataMb: number;
  throughputMbPerMin: number;
  estimatedMinutes: number;
  budgetMinutes: number;
}

export interface PilotBudgets {
  singleDevice: number;
  business: number;
}

export interface PilotResult {
  topology: PilotTopology;
  days: number;
  seed: number;
  offlineDays: number[];
  cloudSyncers: string[];
  deviceSummaries: PilotDeviceSummary[];
  daily: PilotDailyTotals[];
  totals: {
    cloudRequests: number;
    lanRequests: number;
    sales: number;
    conflicts: number;
    syncCycles: number;
    bootstrapRequests: number;
    perDayAverage: number;
    peakDay: PilotPeak | null;
    rowsRecovered: number;
    backlogAtEnd: number;
  };
  budgets: PilotBudgets;
  restore: PilotRestoreEstimate;
}

export interface PilotBudgetReport {
  ok: boolean;
  failures: string[];
  budgets: PilotBudgets;
}

/** Techos por ruta que fija el plan (solicitudes/día). */
const PILOT_LIMITS = Object.freeze({
  push: 96,
  pull: 48,
  bootstrap: 34,
  lease: 2,
  rates: 48,
  planNotifications: 1
});

export const PILOT_DEVICE_BUDGET = 100;
const PILOT_BUSINESS_BUDGET = 500;
export const PILOT_RESTORE_BUDGET_MINUTES = 15;

/** Ventana activa de la tienda: 12 h (720 min) de lunes a sábado. */
const ACTIVE_WINDOW_MIN = 12 * 60;
const PUSH_CYCLE_MIN = 15;
const PULL_CYCLE_MIN = 30;
const RATES_CYCLE_MIN = 90;
const MAX_PUSH_CYCLES = Math.floor(ACTIVE_WINDOW_MIN / PUSH_CYCLE_MIN); // 48
const MAX_PULL_CYCLES = Math.floor(ACTIVE_WINDOW_MIN / PULL_CYCLE_MIN); // 24
const MAX_RATES_CYCLES = Math.floor(ACTIVE_WINDOW_MIN / RATES_CYCLE_MIN); // 8
/** Cada lote agrupa dos ventas: a más volumen, más ciclos con filas. */
const SALES_PER_PUSH = 2;
/** Bootstrap: 34 solicitudes repartidas en los tres primeros días en línea. */
const BOOTSTRAP_SPLIT: readonly number[] = Object.freeze([12, 11, 11]);
const DEFAULT_OFFLINE_DAYS: readonly number[] = Object.freeze([9, 10, 18, 24]);
const DEFAULT_SEED = 20261117;
const BYTES_PER_ROW = 768;
const ROWS_PER_SALE = 4.2;

const DEFAULT_DEVICES: readonly PilotDeviceSpec[] = Object.freeze([
  { id: "pc-caja-1", label: "PC Caja 1", kind: "pc", salesPerDay: 45 },
  { id: "pc-caja-2", label: "PC Caja 2", kind: "pc", salesPerDay: 30 },
  { id: "movil-1", label: "Móvil 1", kind: "phone", salesPerDay: 12 },
  { id: "movil-2", label: "Móvil 2", kind: "phone", salesPerDay: 10 },
  { id: "tablet-1", label: "Tablet 1", kind: "tablet", salesPerDay: 18 }
]);

/* ------------------------------------------------------------------ */
/* Utilidades puras                                                    */
/* ------------------------------------------------------------------ */

/** PRNG mulberry32: mismo estado inicial, misma secuencia, sin timers. */
export function createPrng(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, rounded));
}

function clampNumber(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numeric));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

function resolveDevices(count: number, specs?: PilotDeviceSpec[]): PilotDeviceSpec[] {
  const wanted = clampInt(count, 1, 50);
  const base = (specs && specs.length > 0 ? specs : [...DEFAULT_DEVICES]).map((spec) => ({
    ...spec,
    salesPerDay: Math.max(0, Math.trunc(spec.salesPerDay)),
    onlineFromDay: Math.max(1, Math.trunc(spec.onlineFromDay ?? 1))
  }));
  const devices = base.slice(0, Math.max(1, wanted));
  let extra = 1;
  while (devices.length < Math.max(1, wanted)) {
    devices.push({
      id: `extra-${extra}`,
      label: `Equipo extra ${extra}`,
      kind: "phone",
      salesPerDay: 8,
      onlineFromDay: 1
    });
    extra += 1;
  }
  return devices;
}

function normalizeOfflineDays(input: number[], days: number): number[] {
  const unique = new Set<number>();
  for (const raw of input) {
    const day = Math.trunc(raw);
    if (Number.isFinite(day) && day >= 1 && day <= days) unique.add(day);
  }
  return [...unique].sort((a, b) => a - b);
}

function pickSyncer(specs: PilotDeviceSpec[], hubDeviceId?: string): number {
  if (hubDeviceId) {
    const explicit = specs.findIndex((spec) => spec.id === hubDeviceId);
    if (explicit >= 0) return explicit;
  }
  const pc = specs.findIndex((spec) => spec.kind === "pc");
  return pc >= 0 ? pc : 0;
}

/** Presupuestos aplicables a la topología y al tamaño del negocio. */
export function pilotBudgets(topology: PilotTopology, devices: number): PilotBudgets {
  const business =
    topology === "hub"
      ? PILOT_DEVICE_BUDGET
      : Math.min(PILOT_BUSINESS_BUDGET, PILOT_DEVICE_BUDGET * Math.max(1, devices));
  return { singleDevice: PILOT_DEVICE_BUDGET, business };
}

/* ------------------------------------------------------------------ */
/* Simulación                                                          */
/* ------------------------------------------------------------------ */

export function simulatePilot(options: PilotOptions = {}): PilotResult {
  const days = clampInt(options.days ?? 28, 1, 366);
  const topology: PilotTopology = options.topology === "direct" ? "direct" : "hub";
  const seed = Number.isFinite(options.seed) ? Math.trunc(options.seed as number) : DEFAULT_SEED;
  const specs = resolveDevices(options.devices ?? DEFAULT_DEVICES.length, options.deviceSpecs);
  const offlineDays = normalizeOfflineDays(options.offlineDays ?? [...DEFAULT_OFFLINE_DAYS], days);
  const offlineSet = new Set(offlineDays);
  const conflictRate = clampNumber(options.conflictRate ?? 0.06, 0, 1);
  const throughput = Math.max(1, options.restoreThroughputMbPerMin ?? 40);
  const overhead = Math.max(0, options.restoreOverheadMin ?? 1.5);

  const rng = createPrng(seed);

  // Ventas y conflictos se deciden antes del tráfico de red: así el resultado
  // no depende de la topología elegida.
  const salesMatrix: number[][] = [];
  const conflictMatrix: number[][] = [];
  for (let di = 0; di < specs.length; di += 1) {
    const salesRow: number[] = [];
    const conflictRow: number[] = [];
    for (let day = 0; day < days; day += 1) {
      salesRow.push(specs[di].salesPerDay + Math.floor(rng() * 3));
      let conflicts = 0;
      if (rng() < conflictRate) conflicts = rng() < 0.25 ? 2 : 1;
      conflictRow.push(conflicts);
    }
    salesMatrix.push(salesRow);
    conflictMatrix.push(conflictRow);
  }

  const businessSalesByDay = new Array<number>(days).fill(0);
  for (let di = 0; di < specs.length; di += 1) {
    const from = specs[di].onlineFromDay ?? 1;
    for (let day = 0; day < days; day += 1) {
      if (day + 1 >= from) businessSalesByDay[day] += salesMatrix[di][day];
    }
  }

  const syncerIndex = topology === "hub" ? pickSyncer(specs, options.hubDeviceId) : -1;
  const deviceSummaries: PilotDeviceSummary[] = [];
  let rowsRecovered = 0;

  for (let di = 0; di < specs.length; di += 1) {
    const spec = specs[di];
    const isCloudSyncer = topology === "direct" || di === syncerIndex;
    const from = spec.onlineFromDay ?? 1;
    const deviceDays: PilotDeviceDay[] = [];
    let bootstrapStage = 0;
    let backlog = 0;

    for (let day = 0; day < days; day += 1) {
      const dayNumber = day + 1;
      const onboarded = dayNumber >= from;
      const online = onboarded && !offlineSet.has(dayNumber);
      const daySales = onboarded ? salesMatrix[di][day] : 0;

      let push = 0;
      let pull = 0;
      let bootstrap = 0;
      let lease = 0;
      let rates = 0;
      let plan = 0;
      let lanPush = 0;
      let lanPull = 0;
      let lanLease = 0;
      let lanRates = 0;
      let lanBootstrap = 0;

      if (isCloudSyncer) {
        if (online) {
          // En hub el syncer sube las filas de todo el negocio; en directo, las
          // propias. El backlog de los cortes entra en el mismo lote.
          const queuedSales = backlog + (topology === "hub" ? businessSalesByDay[day] : daySales);
          push = clampInt(Math.ceil(queuedSales / SALES_PER_PUSH), 1, MAX_PUSH_CYCLES);
          pull = Math.min(PILOT_LIMITS.pull, MAX_PULL_CYCLES);
          lease = PILOT_LIMITS.lease;
          rates = Math.min(PILOT_LIMITS.rates, MAX_RATES_CYCLES);
          plan = PILOT_LIMITS.planNotifications;
          if (bootstrapStage < BOOTSTRAP_SPLIT.length) {
            bootstrap = BOOTSTRAP_SPLIT[bootstrapStage];
            bootstrapStage += 1;
          }
          rowsRecovered += backlog;
          backlog = 0;
        } else {
          // Sin internet las ventas siguen: se encolan para el próximo enlace.
          backlog += topology === "hub" ? businessSalesByDay[day] : daySales;
        }
      } else if (onboarded) {
        // Cliente LAN: la red local no depende de internet, así que sigue
        // empujando aunque el negocio esté sin enlace a la nube. El hub hace de
        // puente, también del bootstrap inicial, la licencia y las tasas.
        lanPush = clampInt(Math.ceil(daySales / SALES_PER_PUSH), 1, MAX_PUSH_CYCLES);
        lanPull = MAX_PULL_CYCLES;
        lanLease = PILOT_LIMITS.lease;
        lanRates = Math.min(PILOT_LIMITS.rates, MAX_RATES_CYCLES);
        if (bootstrapStage < BOOTSTRAP_SPLIT.length) {
          lanBootstrap = BOOTSTRAP_SPLIT[bootstrapStage];
          bootstrapStage += 1;
        }
      }

      deviceDays.push({
        day: dayNumber,
        deviceId: spec.id,
        online,
        sales: daySales,
        push,
        pull,
        bootstrap,
        lease,
        rates,
        plan,
        cloudRequests: push + pull + bootstrap + lease + rates + plan,
        lanRequests: lanPush + lanPull + lanLease + lanRates + lanBootstrap,
        syncCycles: push + pull + lanPush + lanPull,
        conflicts: onboarded ? conflictMatrix[di][day] : 0,
        backlogRows: backlog
      });
    }

    deviceSummaries.push(buildDeviceSummary(spec, deviceDays, isCloudSyncer, days));
  }

  const daily: PilotDailyTotals[] = [];
  for (let day = 0; day < days; day += 1) {
    let cloud = 0;
    let lan = 0;
    let sales = 0;
    let conflicts = 0;
    let anyOnline = false;
    for (const summary of deviceSummaries) {
      const entry = summary.days[day];
      cloud += entry.cloudRequests;
      lan += entry.lanRequests;
      sales += entry.sales;
      conflicts += entry.conflicts;
      if (entry.online) anyOnline = true;
    }
    daily.push({
      day: day + 1,
      cloudRequests: cloud,
      lanRequests: lan,
      sales,
      conflicts,
      online: anyOnline
    });
  }

  const totalsCloud = daily.reduce((sum, day) => sum + day.cloudRequests, 0);
  const totalsLan = daily.reduce((sum, day) => sum + day.lanRequests, 0);
  const salesTotal = daily.reduce((sum, day) => sum + day.sales, 0);
  const conflictsTotal = daily.reduce((sum, day) => sum + day.conflicts, 0);
  const cyclesTotal = deviceSummaries.reduce((sum, device) => sum + device.syncCycles, 0);
  const bootstrapTotal = deviceSummaries.reduce((sum, device) => sum + device.bootstrapRequests, 0);
  const backlogAtEnd = deviceSummaries.reduce(
    (sum, device) => sum + (device.days[device.days.length - 1]?.backlogRows ?? 0),
    0
  );

  const rows = Math.round(salesTotal * ROWS_PER_SALE);
  const dataMb = round2((rows * BYTES_PER_ROW) / (1024 * 1024));
  const estimatedMinutes = round2(overhead + dataMb / throughput);

  return {
    topology,
    days,
    seed,
    offlineDays,
    cloudSyncers: deviceSummaries.filter((device) => device.cloudSyncer).map((device) => device.deviceId),
    deviceSummaries,
    daily,
    totals: {
      cloudRequests: totalsCloud,
      lanRequests: totalsLan,
      sales: salesTotal,
      conflicts: conflictsTotal,
      syncCycles: cyclesTotal,
      bootstrapRequests: bootstrapTotal,
      perDayAverage: round2(totalsCloud / days),
      peakDay: pickPeak(daily.map((day) => ({ day: day.day, requests: day.cloudRequests }))),
      rowsRecovered,
      backlogAtEnd
    },
    budgets: pilotBudgets(topology, specs.length),
    restore: {
      rows,
      dataMb,
      throughputMbPerMin: throughput,
      estimatedMinutes,
      budgetMinutes: PILOT_RESTORE_BUDGET_MINUTES
    }
  };
}

function buildDeviceSummary(
  spec: PilotDeviceSpec,
  days: PilotDeviceDay[],
  cloudSyncer: boolean,
  windowDays: number
): PilotDeviceSummary {
  let cloud = 0;
  let lan = 0;
  let sales = 0;
  let conflicts = 0;
  let cycles = 0;
  let bootstrap = 0;
  let offline = 0;
  for (const day of days) {
    cloud += day.cloudRequests;
    lan += day.lanRequests;
    sales += day.sales;
    conflicts += day.conflicts;
    cycles += day.syncCycles;
    bootstrap += day.bootstrap;
    if (!day.online) offline += 1;
  }
  return {
    deviceId: spec.id,
    label: spec.label,
    kind: spec.kind,
    cloudSyncer,
    days,
    totalCloud: cloud,
    totalLan: lan,
    averagePerDay: round2(cloud / Math.max(1, windowDays)),
    peakDay: pickPeak(days.map((day) => ({ day: day.day, requests: day.cloudRequests }))),
    sales,
    conflicts,
    syncCycles: cycles,
    offlineDays: offline,
    bootstrapRequests: bootstrap
  };
}

function pickPeak(entries: Array<{ day: number; requests: number }>): PilotPeak | null {
  let peak: PilotPeak | null = null;
  for (const entry of entries) {
    if (!peak || entry.requests > peak.requests) peak = { day: entry.day, requests: entry.requests };
  }
  return peak && peak.requests > 0 ? peak : null;
}

/* ------------------------------------------------------------------ */
/* Presupuestos                                                        */
/* ------------------------------------------------------------------ */

export function assertPilotBudgets(result: PilotResult): PilotBudgetReport {
  const failures: string[] = [];
  const { budgets } = result;

  for (const device of result.deviceSummaries) {
    if (device.averagePerDay >= budgets.singleDevice) {
      failures.push(
        `Presupuesto por equipo excedido: ${device.label} promedia ${device.averagePerDay}/día (límite ${budgets.singleDevice})`
      );
    }
  }

  if (result.totals.perDayAverage >= budgets.business) {
    failures.push(
      `Presupuesto del negocio excedido: ${result.totals.perDayAverage}/día (límite ${budgets.business})`
    );
  }

  if (result.restore.estimatedMinutes >= PILOT_RESTORE_BUDGET_MINUTES) {
    failures.push(
      `Restauración demasiado lenta: ${result.restore.estimatedMinutes} min (límite ${PILOT_RESTORE_BUDGET_MINUTES} min)`
    );
  }

  if (result.topology === "hub" && result.cloudSyncers.length !== 1) {
    failures.push(
      `Topología hub con ${result.cloudSyncers.length} syncer(s) en la nube; debe haber exactamente 1`
    );
  }

  if (result.totals.backlogAtEnd > 0) {
    failures.push(`Quedaron ${result.totals.backlogAtEnd} fila(s) sin subir al cierre del piloto`);
  }

  return { ok: failures.length === 0, failures, budgets };
}

/* ------------------------------------------------------------------ */
/* Informe                                                             */
/* ------------------------------------------------------------------ */

function chunkSeries(
  days: PilotDeviceDay[],
  pick: (day: PilotDeviceDay) => number,
  prefix: string,
  size = 7
): string[] {
  const lines: string[] = [];
  for (let index = 0; index < days.length; index += size) {
    const slice = days.slice(index, index + size);
    lines.push(
      `    ${prefix} días ${slice[0].day}-${slice[slice.length - 1].day}: ${slice.map(pick).join("/")}`
    );
  }
  return lines;
}

export function formatPilotReport(result: PilotResult): string {
  const lines: string[] = [];
  const topologyLabel = result.topology === "hub" ? "hub" : "directa";
  const offlineLabel = result.offlineDays.length > 0 ? result.offlineDays.join(", ") : "ninguno";
  const syncerLabels = result.deviceSummaries
    .filter((device) => device.cloudSyncer)
    .map((device) => device.label);
  const deviceWord = result.deviceSummaries.length === 1 ? "equipo" : "equipos";

  lines.push(
    `Piloto PALMYRA · ${result.days} días · ${result.deviceSummaries.length} ${deviceWord} · topología ${topologyLabel}`
  );
  lines.push(`Semilla ${result.seed} · días sin internet: ${offlineLabel} (${result.offlineDays.length})`);
  lines.push(`Syncer en la nube: ${syncerLabels.join(", ")}`);
  lines.push("");
  lines.push("Equipo                   Tipo    Enlace  Total nube   Media/día   Pico");
  for (const device of result.deviceSummaries) {
    const peak = device.peakDay ? `día ${device.peakDay.day} (${device.peakDay.requests})` : "sin uso";
    lines.push(
      `${padRight(device.label, 24)} ${padRight(device.kind, 7)} ${padRight(
        device.cloudSyncer ? "nube" : "LAN",
        7
      )} ${padLeft(fixed(device.totalCloud, 0), 10)} ${padLeft(fixed(device.averagePerDay, 1), 11)}   ${peak}`
    );
    lines.push(...chunkSeries(device.days, (day) => day.cloudRequests, "nube"));
    if (device.totalLan > 0) {
      lines.push(...chunkSeries(device.days, (day) => day.lanRequests, "LAN "));
    }
  }
  lines.push("");
  lines.push(`Solicitudes a la nube (total): ${result.totals.cloudRequests}`);
  lines.push(`Promedio diario del negocio: ${fixed(result.totals.perDayAverage, 1)}/día`);
  lines.push(
    `Pico: día ${result.totals.peakDay?.day ?? "-"} con ${result.totals.peakDay?.requests ?? 0} solicitudes`
  );
  lines.push(`Tráfico LAN (no cuenta contra la nube): ${result.totals.lanRequests}`);
  lines.push(
    `Ventas simuladas: ${result.totals.sales} · filas recuperadas tras cortes: ${result.totals.rowsRecovered} · pendientes al cierre: ${result.totals.backlogAtEnd}`
  );
  lines.push(
    `Conflictos resueltos: ${result.totals.conflicts} · Ciclos de sincronización: ${result.totals.syncCycles} · Bootstrap: ${result.totals.bootstrapRequests}`
  );
  lines.push(
    `Restauración estimada: ${fixed(result.restore.estimatedMinutes, 1)} min para ${fixed(
      result.restore.dataMb,
      1
    )} MB a ${fixed(result.restore.throughputMbPerMin, 0)} MB/min (límite ${result.restore.budgetMinutes} min)`
  );

  const worstDevice = result.deviceSummaries.reduce(
    (max, device) => Math.max(max, device.averagePerDay),
    0
  );
  const deviceOk = worstDevice < result.budgets.singleDevice;
  const businessOk = result.totals.perDayAverage < result.budgets.business;
  lines.push(
    `Presupuesto por equipo (<${result.budgets.singleDevice}/día): ${
      deviceOk ? "OK" : "FALLA"
    } (máximo ${fixed(worstDevice, 1)}/día)`
  );
  lines.push(
    `Presupuesto del negocio (<${result.budgets.business}/día): ${
      businessOk ? "OK" : "FALLA"
    } (media ${fixed(result.totals.perDayAverage, 1)}/día)`
  );

  const budget = assertPilotBudgets(result);
  if (budget.ok) {
    lines.push("Veredicto: presupuestos F7 en verde, sin pérdida de funcionalidad");
  } else {
    lines.push("FALLA: presupuesto F7 incumplido");
    for (const failure of budget.failures) lines.push(`  - ${failure}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Ejecución directa                                                   */
/* ------------------------------------------------------------------ */

function summarizeScenario(result: PilotResult, label: string): string {
  const budget = assertPilotBudgets(result);
  return `${label}: ${fixed(result.totals.perDayAverage, 1)} solicitudes/día (límite ${
    result.budgets.business
  }) → ${budget.ok ? "OK" : "FALLA"}`;
}

function main(): number {
  const scenarios: Array<{ label: string; result: PilotResult }> = [
    { label: "hub 5 equipos", result: simulatePilot({ topology: "hub" }) },
    { label: "directa 1 equipo", result: simulatePilot({ topology: "direct", devices: 1 }) },
    { label: "directa 5 equipos", result: simulatePilot({ topology: "direct", devices: 5 }) }
  ];

  for (const scenario of scenarios) {
    console.log(formatPilotReport(scenario.result));
    console.log("");
  }

  console.log("=".repeat(72));
  const failures: string[] = [];
  for (const scenario of scenarios) {
    console.log(summarizeScenario(scenario.result, scenario.label));
    failures.push(...assertPilotBudgets(scenario.result).failures);
  }
  console.log("=".repeat(72));

  if (failures.length > 0) {
    console.error("FALLA: la simulación del piloto incumple el presupuesto F7");
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("Resultado: piloto dentro de presupuesto (hub <100/día, 1 equipo <100/día, 5 equipos <500/día)");
  return 0;
}

const rawArgvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectRun = rawArgvPath !== "" && rawArgvPath === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`FALLA inesperada de la simulación: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function getLocalDateYMD(dStr: string | null | undefined): string {
  if (!dStr) return '';
  const d = new Date(dStr);
  if (isNaN(d.getTime())) return '';
  // Los reportes se fechan en Cuba con independencia de la zona horaria del
  // dispositivo. Antes se usaba la fecha local del equipo y un ticket de las
  // 23:30 (hora de La Habana) podía caer en el día siguiente y desaparecer del
  // filtro «Hoy» en un equipo configurado en otra zona horaria. Es el mismo
  // criterio que ya usan los gráficos por hora y evita que dos equipos vean la
  // misma venta en fechas distintas.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const part = (type: string) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Normaliza una fecha de negocio (`YYYY-MM-DD`) sin reinterpretarla como un
 * instante: `2026-11-25` es el 25 de noviembre en cualquier zona horaria.
 * Devuelve undefined si el texto no es una fecha de calendario válida.
 */
export function normalizeBusinessDateYMD(value: string | null | undefined): string | undefined {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return text;
}

/**
 * Etiqueta legible (`dd/mm/aaaa`) de una fecha de negocio, construida a partir
 * del texto y no de `new Date(...)`, para que nunca se corra un día.
 */
export function formatBusinessDateLabel(value: string | null | undefined): string {
  const ymd = normalizeBusinessDateYMD(value);
  if (!ymd) return '';
  const [year, month, day] = ymd.split('-');
  return `${day}/${month}/${year}`;
}

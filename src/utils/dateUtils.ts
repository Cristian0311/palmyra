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

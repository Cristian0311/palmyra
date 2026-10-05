export function getLocalDateYMD(dStr: string | null | undefined): string {
  if (!dStr) return '';
  const d = new Date(dStr);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

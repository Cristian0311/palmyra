/**
 * JSON canónico para firmar licencias: claves ordenadas, sin espacios y con
 * la misma semántica de escape que JSON.stringify. El servidor debe firmar
 * exactamente este texto.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value as number)) throw new TypeError("Número no finito en JSON canónico");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : serialize(item))).join(",")}]`;
  }
  if (type === "object") {
    if (value instanceof Date) throw new TypeError("Usa fechas ISO en cadenas, no objetos Date");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Tipo no serializable en JSON canónico: ${type}`);
}

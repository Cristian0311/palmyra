/**
 * Detect transport failures independently of navigator.onLine.
 * Browsers often report "online" while Wi-Fi has no Internet access.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!error) return false;
  const value = error as Record<string, unknown>;
  const text = [
    value.name, value.message, value.code, value.details, value.hint,
    typeof error === "string" ? error : ""
  ].filter(Boolean).join(" ");
  return /failed to fetch|fetch failed|networkerror|network request failed|err_internet_disconnected|err_name_not_resolved|err_connection|econnreset|econnrefused|connection reset|connection closed|timed? ?out|timeout|aborterror|signal is aborted without reason|load failed|gateway/i.test(text);
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Verificación pre-instalación de artefactos descargados.
 *
 * Ningún archivo se aplica sin comprobar antes, contra el manifiesto firmado,
 * su tamaño en bytes y su sha256. Estos helpers son puros (no tocan el disco ni
 * la red salvo `downloadVerifiedArtifact`, que recibe el descargador por
 * inyección) y comparten los mensajes en español que muestran las tres
 * superficies (PC, Android y PWA) para que el dueño del negocio siempre vea la
 * misma explicación accionable:
 *
 *   "La descarga no coincide con la versión firmada (tamaño esperado X, recibido Y)."
 *   "La descarga no coincide con la versión firmada. Reintentando…"
 *   "La descarga no coincide con la versión firmada y no se aplicará."
 *
 * Regla de oro: un desajuste NUNCA instala. Se reintenta una sola vez y, si
 * vuelve a fallar, el artefacto se descarta y la versión instalada queda
 * intacta (rollback seguro).
 */

export type ArtifactCheckReason =
  | "ok"
  | "not-available"
  | "size-mismatch"
  | "hash-mismatch";

export interface ArtifactCheck {
  ok: boolean;
  reason: ArtifactCheckReason;
  /** Mensaje en español listo para mostrar al usuario. */
  message: string;
  expectedBytes: number;
  actualBytes: number | null;
  expectedSha256: string;
  actualSha256: string | null;
}

export const RETRY_MESSAGE = "La descarga no coincide con la versión firmada. Reintentando…";
export const REJECTED_MESSAGE =
  "La descarga no coincide con la versión firmada y no se aplicará. Vuelve a buscar actualizaciones.";

function check(
  name: string,
  reason: ArtifactCheckReason,
  message: string,
  expectedBytes: number,
  actualBytes: number | null,
  expectedSha256: string,
  actualSha256: string | null
): ArtifactCheck {
  return { ok: reason === "ok", reason, message, expectedBytes, actualBytes, expectedSha256, actualSha256 };
}

/** Compara el tamaño descargado contra el byte declarado en el manifiesto firmado. */
export function verifyArtifactSize(params: {
  name: string;
  expectedBytes: number;
  actualBytes: number;
}): ArtifactCheck {
  const { name, expectedBytes, actualBytes } = params;
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    return check(
      name,
      "not-available",
      `No se pudo conocer el tamaño real de la descarga de ${name}; no se aplicará.`,
      expectedBytes,
      null,
      "",
      null
    );
  }
  if (actualBytes !== expectedBytes) {
    return check(
      name,
      "size-mismatch",
      `La descarga no coincide con la versión firmada (tamaño esperado ${expectedBytes}, recibido ${actualBytes}).`,
      expectedBytes,
      actualBytes,
      "",
      null
    );
  }
  return check(name, "ok", "", expectedBytes, actualBytes, "", null);
}

/** Compara el sha256 descargado contra el declarado en el manifiesto firmado. */
export function verifyArtifactSha256(params: {
  name: string;
  expectedSha256: string;
  actualSha256: string;
}): ArtifactCheck {
  const { name, expectedSha256, actualSha256 } = params;
  if (typeof actualSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(actualSha256)) {
    return check(
      name,
      "not-available",
      `No se pudo calcular el sha256 real de la descarga de ${name}; no se aplicará.`,
      0,
      null,
      expectedSha256.toLowerCase(),
      null
    );
  }
  const actual = actualSha256.toLowerCase();
  if (actual !== expectedSha256.toLowerCase()) {
    return check(
      name,
      "hash-mismatch",
      `La descarga no coincide con la versión firmada (sha256 esperado ${expectedSha256}, recibido ${actual}).`,
      0,
      null,
      expectedSha256.toLowerCase(),
      actual
    );
  }
  return check(name, "ok", "", 0, null, expectedSha256.toLowerCase(), actual);
}

/**
 * Verificación completa pre-instalación: primero el tamaño (barato) y solo si
 * coincide, el sha256 (caro). Devuelve un ArtifactCheck con `ok: true`
 * únicamente cuando AMBOS coinciden con el manifiesto firmado.
 */
export function verifyDownloadedArtifact(params: {
  name: string;
  expectedBytes: number;
  expectedSha256: string;
  actualBytes: number | null;
  actualSha256: string | null;
}): ArtifactCheck {
  const { name, expectedBytes, expectedSha256, actualBytes, actualSha256 } = params;
  if (actualBytes === null) {
    return check(
      name,
      "not-available",
      `No se pudo conocer el tamaño real de la descarga de ${name}; no se aplicará.`,
      expectedBytes,
      null,
      expectedSha256.toLowerCase(),
      actualSha256 === null ? null : actualSha256.toLowerCase()
    );
  }
  const size = verifyArtifactSize({ name, expectedBytes, actualBytes });
  if (!size.ok) {
    return {
      ...size,
      expectedSha256: expectedSha256.toLowerCase(),
      actualSha256: actualSha256 === null ? null : actualSha256.toLowerCase()
    };
  }
  if (actualSha256 === null) {
    return check(
      name,
      "not-available",
      `No se pudo calcular el sha256 real de la descarga de ${name}; no se aplicará.`,
      expectedBytes,
      actualBytes,
      expectedSha256.toLowerCase(),
      null
    );
  }
  const hash = verifyArtifactSha256({ name, expectedSha256, actualSha256 });
  if (!hash.ok) {
    return { ...hash, expectedBytes, actualBytes };
  }
  return check(
    name,
    "ok",
    "",
    expectedBytes,
    actualBytes,
    expectedSha256.toLowerCase(),
    actualSha256.toLowerCase()
  );
}

/** sha256 en hexadecimal de un ArrayBuffer/Uint8Array vía WebCrypto. */
export async function sha256HexOf(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

export interface DownloadAttempt {
  /** Bytes descargados, o null si la descarga falló (error de transporte). */
  data: Uint8Array | null;
  /** Motivo del fallo de transporte, si lo hubo. */
  error?: string;
}

export interface DownloadVerifiedResult {
  ok: boolean;
  reason: ArtifactCheckReason;
  /** Mensaje en español: vacío si ok, accionable si no. */
  message: string;
  /** Bytes verificados contra la firma; null si nunca se verificaron. */
  data: Uint8Array | null;
  attempts: number;
  check: ArtifactCheck | null;
}

/**
 * Descarga y verifica ANTES de aplicar: tamaño y sha256 contra el manifiesto
 * firmado. Si la primera descarga no coincide, reintenta UNA vez (con el aviso
 * "Reintentando…"); si tampoco, devuelve ok:false y NUNCA entrega el archivo
 * para instalar. Los errores de transporte se propagan sin consumir reintentos
 * de integridad (el llamador decide su política de red).
 */
export async function downloadVerifiedArtifact(options: {
  name: string;
  expectedBytes: number;
  expectedSha256: string;
  download: () => Promise<DownloadAttempt>;
  /** Reintentos por desajuste de integridad (por defecto 1). */
  maxAttempts?: number;
  /** Aviso intermedio, p. ej. para la UI ("Reintentando…"). */
  onRetry?: (message: string) => void;
}): Promise<DownloadVerifiedResult> {
  const { name, expectedBytes, expectedSha256, download, onRetry } = options;
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 2));

  let lastCheck: ArtifactCheck | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await download();
    if (!result.data) {
      return {
        ok: false,
        reason: "not-available",
        message:
          result.error ??
          `No se pudo descargar ${name}; la versión instalada queda intacta.`,
        data: null,
        attempts: attempt,
        check: null
      };
    }
    const actualBytes = result.data.byteLength;
    const actualSha256 = await sha256HexOf(result.data);
    const checkResult = verifyDownloadedArtifact({
      name,
      expectedBytes,
      expectedSha256,
      actualBytes,
      actualSha256
    });
    lastCheck = checkResult;
    if (checkResult.ok) {
      return {
        ok: true,
        reason: "ok",
        message: "",
        data: result.data,
        attempts: attempt,
        check: checkResult
      };
    }
    if (attempt < maxAttempts) {
      onRetry?.(RETRY_MESSAGE);
    }
  }
  return {
    ok: false,
    reason: lastCheck?.reason ?? "hash-mismatch",
    message: REJECTED_MESSAGE,
    data: null,
    attempts: maxAttempts,
    check: lastCheck
  };
}

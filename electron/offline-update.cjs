'use strict';

// Verificación del instalador que llega por USB o a mano. Este módulo es puro
// (no importa electron ni child_process) para poder probarlo con node: el
// proceso principal se encarga de ejecutar PowerShell y de lanzar el Setup.
//
// Regla de oro: si no se puede demostrar que el archivo está firmado por un
// editor válido y que su versión es más nueva, no se instala nada.

// Get-AuthenticodeSignature con -LiteralPath: la ruta se inyecta entre comillas
// simples y el main duplica las comillas simples del nombre (única secuencia que
// PowerShell interpreta dentro de una cadena literal).
const SIGNATURE_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sig = Get-AuthenticodeSignature -LiteralPath '__PATH__'",
  '$palmyraStatus = ""',
  '$palmyraSubject = ""',
  '$palmyraThumbprint = ""',
  'if ($sig) {',
  '  if ($sig.Status) { $palmyraStatus = [string]$sig.Status }',
  '  if ($sig.SignerCertificate) {',
  '    $palmyraSubject = [string]$sig.SignerCertificate.Subject',
  '    $palmyraThumbprint = [string]$sig.SignerCertificate.Thumbprint',
  '  }',
  '}',
  '[pscustomobject]@{ Status = $palmyraStatus; Subject = $palmyraSubject; Thumbprint = $palmyraThumbprint } | ConvertTo-Json -Compress'
].join('\n');

// Versión de producto declarada por el propio ejecutable. ConvertTo-Json no se
// usa aquí: se devuelve una única línea de texto que parseProductVersion valida.
const VERSION_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$palmyraInfo = (Get-Item -LiteralPath '__PATH__').VersionInfo",
  '$palmyraValue = [string]$palmyraInfo.ProductVersion',
  'if ([string]::IsNullOrWhiteSpace($palmyraValue)) { $palmyraValue = [string]$palmyraInfo.FileVersion }',
  'Write-Output $palmyraValue'
].join('\n');

// "1.2.3" o "1.2.3.4", sin sufijos: un instalador de PALMYRA usa versiones
// numéricas. Cualquier otra cosa (vacío, "1.2", "1.2.3-beta") es ilegible.
const PRODUCT_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/;
// Para comparar se aceptan de 1 a 4 componentes; los que falten valen 0.
const LOOSE_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;

function readField(source, name) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return source[key];
  }
  return undefined;
}

function readText(source, name) {
  const value = readField(source, name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Interpreta la salida JSON de Get-AuthenticodeSignature (ConvertTo-Json).
 * Tolera BOM, nombres de campo con otra capitalización, respuestas en lista y
 * certificados ausentes o nulos. Devuelve null cuando la salida no es un objeto
 * reconocible (p. ej. un error de PowerShell o una cadena suelta).
 */
function parseAuthenticodeJson(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed.length > 0 ? parsed[0] : null;
  if (!parsed || typeof parsed !== 'object') return null;

  const status = readText(parsed, 'Status');
  const certificate = readField(parsed, 'SignerCertificate');
  const subject = certificate && typeof certificate === 'object' ? readText(certificate, 'Subject') : '';
  const thumbprint = certificate && typeof certificate === 'object' ? readText(certificate, 'Thumbprint') : '';
  if (!status && !subject && !thumbprint) return null;
  return { status, subject, thumbprint };
}

/**
 * Normaliza la versión de producto del ejecutable. Solo se aceptan componentes
 * numéricos (3 o 4); se devuelven siempre los tres primeros para comparar de
 * forma estable entre "1.3.6" y "1.3.6.0".
 */
function parseProductVersion(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^\uFEFF/, '').trim();
  const match = PRODUCT_VERSION_RE.exec(text);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((value) => String(Number(value)));
  return parts.join('.');
}

/**
 * Compara dos versiones numéricas de hasta 4 componentes (las que falten valen
 * 0). Devuelve >0 si `a` es más nueva, <0 si es más antigua y 0 si son iguales.
 * Si alguna entrada no es una versión numérica se devuelve 0 (sin orden
 * confiable): quien necesite distinguir "ilegible" de "igual" debe validar
 * antes con parseProductVersion, como hace evaluateOfflineInstaller.
 */
function compareLooseVersions(a, b) {
  const left = typeof a === 'string' ? a.trim() : '';
  const right = typeof b === 'string' ? b.trim() : '';
  if (!LOOSE_VERSION_RE.test(left) || !LOOSE_VERSION_RE.test(right)) return 0;
  const leftParts = left.split('.').map((value) => Number(value));
  const rightParts = right.split('.').map((value) => Number(value));
  for (let index = 0; index < 4; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

/** Huella del certificado sin espacios ni dos puntos, en mayúsculas. */
function normalizeThumbprint(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s:]/g, '').toUpperCase();
}

/**
 * Decide si un instalador local puede ejecutarse.
 *
 * - `unsigned`: la firma Authenticode no es válida o no hay certificado del
 *   firmante que se pueda atribuir (sin huella no hay editor identificable).
 * - `publisher-mismatch`: hay huella fijada y no coincide.
 * - `version-unknown`: no se pudo leer la versión del ejecutable o la versión
 *   instalada, así que no hay forma de descartar una instalación hacia atrás.
 * - `not-newer`: la versión del instalador es igual o menor que la actual.
 *
 * La huella fijada es opcional (variable de entorno), pero el resto de
 * condiciones son obligatorias: nunca se acepta un archivo sin firma válida ni
 * una versión que no sea estrictamente más nueva.
 */
function evaluateOfflineInstaller(input) {
  const data = input && typeof input === 'object' ? input : {};
  const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
  if (status !== 'valid') return { ok: false, code: 'unsigned' };

  const thumbprint = normalizeThumbprint(data.thumbprint);
  if (!thumbprint) return { ok: false, code: 'unsigned' };

  const pinned = normalizeThumbprint(data.pinnedThumbprint);
  if (pinned && thumbprint !== pinned) return { ok: false, code: 'publisher-mismatch' };

  const productVersion = typeof data.productVersion === 'string'
    ? parseProductVersion(data.productVersion)
    : null;
  const currentVersion = typeof data.currentVersion === 'string' ? data.currentVersion.trim() : '';
  if (!productVersion || !currentVersion) return { ok: false, code: 'version-unknown' };

  if (compareLooseVersions(productVersion, currentVersion) <= 0) return { ok: false, code: 'not-newer' };
  return { ok: true };
}

module.exports = {
  SIGNATURE_PS_SCRIPT,
  VERSION_PS_SCRIPT,
  parseAuthenticodeJson,
  parseProductVersion,
  compareLooseVersions,
  normalizeThumbprint,
  evaluateOfflineInstaller
};

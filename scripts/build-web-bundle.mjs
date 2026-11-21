/**
 * Empaqueta la app web compilada (dist/) en un ZIP que el APK descarga para
 * actualizarse sin instalar otro APK. El manifiesto version.json publica el
 * nombre, tamaño y SHA-256 del paquete para que el shell Android lo verifique
 * antes de reemplazar la versión en uso.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const distDir = path.resolve(root, 'dist');
const releasesDir = path.join(distDir, 'releases');
const version = String(JSON.parse(fs.readFileSync(path.resolve(root, 'app-version.json'), 'utf8')).version || '').trim();

if (!/^\d+(\.\d+){1,3}$/.test(version)) {
  throw new Error(`Versión inválida en app-version.json: "${version}"`);
}
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  throw new Error('dist/index.html no existe. Ejecuta vite build antes del empaquetado OTA.');
}

// El ZIP es lo que recibe el teléfono, no el APK: nunca debe contener el
// servidor Node, el propio paquete ni manifiestos de versión.
const EXCLUDED_TOP_LEVEL = new Set([
  'releases',
  'version.json',
  'server.cjs',
  'server.cjs.map',
  'desktop-server.cjs',
]);

function collectFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
  }
  return files;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const data = fs.readFileSync(entry.absolute);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(entry.relative, 'utf8');
    const { dosTime, dosDate } = dosTimestamp(fs.statSync(entry.absolute).mtime);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(Buffer.concat([central, name]));

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

const files = collectFiles(distDir);
if (!files.some((file) => file.relative === 'index.html')) {
  throw new Error('El paquete OTA no contiene index.html.');
}

const zipName = `palmyra-web-${version}.zip`;
const zipPath = path.join(releasesDir, zipName);
fs.mkdirSync(releasesDir, { recursive: true });
fs.writeFileSync(zipPath, buildZip(files));

const zipStats = fs.statSync(zipPath);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');

const manifestPath = path.join(distDir, 'version.json');
const currentManifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { app: 'PALMYRA', version };

const manifest = {
  ...currentManifest,
  app: 'PALMYRA',
  version,
  webBundle: `/releases/${zipName}`,
  webBundleSha256: sha256,
  webBundleBytes: zipStats.size,
  webBundleBuiltAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const kb = (zipStats.size / 1024).toFixed(0);
console.log(`[PALMYRA] Bundle OTA listo: ${zipName} (${files.length} archivos, ${kb} KB)`);
console.log(`[PALMYRA] SHA-256 ${sha256}`);
console.log(`[PALMYRA] Manifiesto: ${path.relative(root, manifestPath)}`);

import { createHash } from 'node:crypto';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const findings = [];
const legacyLargeBaseline = {
  'src/pages/POS.tsx': { lines: 4420, bytes: 235600 },
  'src/pages/Reports.tsx': { lines: 4455, bytes: 248691 },
};
const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'dist-admin', 'coverage', '.cache']);
const duplicateScanRoots = new Set(['public', 'src']);
const intentionalDuplicatePaths = new Set([
  'public/favicon.svg',
  'public/pwa-192.svg',
  'public/pwa-512.svg',
]);

for (const dir of ['fixrender', 'dev-dist']) {
  if (existsSync(join(root, dir))) {
    findings.push({ level: 'high', message: `Directorio heredado/no productivo presente: ${dir}/` });
  }
}

const duplicateHashes = new Map();

function recordDuplicateCandidate(abs, rel) {
  const rootName = rel.split('/')[0];
  if (!duplicateScanRoots.has(rootName) || intentionalDuplicatePaths.has(rel)) return;
  try {
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
    const bucket = duplicateHashes.get(hash) || [];
    bucket.push(rel);
    duplicateHashes.set(hash, bucket);
  } catch {
    // Ignore unreadable/binary files; the build will validate required assets.
  }
}

function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;

    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }

    const rel = relative(root, abs).replaceAll('\\', '/');
    const name = entry.name;

    recordDuplicateCandidate(abs, rel);

    if (/\.(bak(?:_[^.]*)?|tmp|orig|rej)$/i.test(name) || /(?:HOTFIX|REPAIR|LIVE_REPAIR)/i.test(name)) {
      findings.push({ level: 'high', message: `Artefacto histórico/temporal versionado: ${rel}` });
    }

    if (/\.(tsx?|jsx?)$/i.test(name)) {
      const bytes = statSync(abs).size;
      const lineCount = (() => {
        try { return readFileSync(abs, 'utf8').split(/\r?\n/).length; } catch { return 0; }
      })();
      const baseline = legacyLargeBaseline[rel];

      if (lineCount >= 3500) {
        findings.push({ level: 'high', message: `Archivo fuente >= 3500 líneas: ${rel} (${lineCount}). El límite de mantenimiento es 3499 líneas; extrae lógica a módulos.` });
      } else if (lineCount >= 2500) {
        findings.push({ level: 'medium', message: `Archivo fuente >= 2500 líneas: ${rel} (${lineCount})` });
      }

      if (bytes >= 220000) {
        const regressed = baseline ? bytes > baseline.bytes : true;
        findings.push({ level: regressed ? 'high' : 'medium', message: `Archivo fuente >= 220 KB: ${rel} (${bytes} bytes)` });
      } else if (bytes >= 140000) {
        findings.push({ level: 'medium', message: `Archivo fuente >= 140 KB: ${rel} (${bytes} bytes)` });
      }
    }
  }
}

walk(root);

for (const duplicatePaths of duplicateHashes.values()) {
  if (duplicatePaths.length > 1) {
    findings.push({
      level: 'high',
      message: 'Contenido duplicado en superficie productiva: ' + duplicatePaths.join(', ')
    });
  }
}

if (findings.length === 0) {
  console.log('[PALMYRA architecture] OK');
  process.exit(0);
}

console.log('[PALMYRA architecture] Hallazgos:');
for (const finding of findings) console.log(`[${finding.level.toUpperCase()}] ${finding.message}`);

if (strict && findings.some((f) => f.level === 'high')) process.exitCode = 1;

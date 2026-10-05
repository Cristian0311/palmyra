import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const findings = [];
const legacyLargeBaseline = {
  'src/pages/POS.tsx': { lines: 4420, bytes: 235386 },
  'src/pages/Reports.tsx': { lines: 4455, bytes: 248513 },
};
const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache']);

for (const dir of ['fixrender', 'dev-dist']) {
  if (existsSync(join(root, dir))) {
    findings.push({ level: 'high', message: `Directorio heredado/no productivo presente: ${dir}/` });
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

    const rel = relative(root, abs);
    const name = entry.name;

    if (/\.(bak(?:_[^.]*)?|tmp|orig|rej)$/i.test(name) || /(?:HOTFIX|REPAIR|LIVE_REPAIR)/i.test(name)) {
      findings.push({ level: 'high', message: `Artefacto histórico/temporal versionado: ${rel}` });
    }

    if (/\.(tsx?|jsx?)$/i.test(name)) {
      const bytes = statSync(abs).size;
      const lineCount = (() => {
        try { return readFileSync(abs, 'utf8').split(/\r?\n/).length; } catch { return 0; }
      })();

      if (lineCount >= 4000) {
        findings.push({ level: 'high', message: `Archivo fuente >= 4000 líneas: ${rel} (${lineCount})` });
      } else if (lineCount >= 2500) {
        findings.push({ level: 'medium', message: `Archivo fuente >= 2500 líneas: ${rel} (${lineCount})` });
      }

      if (bytes >= 220000) {
        findings.push({ level: 'high', message: `Archivo fuente >= 220 KB: ${rel} (${bytes} bytes)` });
      } else if (bytes >= 140000) {
        findings.push({ level: 'medium', message: `Archivo fuente >= 140 KB: ${rel} (${bytes} bytes)` });
      }
    }
  }
}

walk(root);

if (findings.length === 0) {
  console.log('[PALMYRA architecture] OK');
  process.exit(0);
}

console.log('[PALMYRA architecture] Hallazgos:');
for (const finding of findings) console.log(`[${finding.level.toUpperCase()}] ${finding.message}`);

if (strict && findings.some((f) => f.level === 'high')) process.exitCode = 1;

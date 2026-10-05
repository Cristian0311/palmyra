import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const findings = [];

for (const dir of ['fixrender', 'dev-dist']) {
  if (existsSync(join(root, dir))) findings.push({ level: 'high', message: `Directorio heredado/no productivo presente: ${dir}/` });
}

function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      const rel = relative(root, abs);
      const bytes = statSync(abs).size;
      const lineCount = (() => {
        try {
          return readFileSync(abs, 'utf8').split(/\r?\n/).length;
        } catch {
          return 0;
        }
      })();

      if (/\.bak(?:_|\.)?/i.test(entry.name)) {
        findings.push({ level: 'high', message: `Backup versionado bajo src: ${rel}` });
      }

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
walk(join(root, 'src'));

if (findings.length === 0) {
  console.log('[PALMYRA architecture] OK');
  process.exit(0);
}

console.log('[PALMYRA architecture] Hallazgos:');
for (const finding of findings) console.log(`[${finding.level.toUpperCase()}] ${finding.message}`);
if (strict && findings.some((f) => f.level === 'high')) process.exitCode = 1;

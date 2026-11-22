import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.resolve('public');
// La versión técnica del build sigue a package.json (la que usan instalador y
// OTA). app-version.json era la etiqueta informativa y dejaba el buildId con
// un prefijo 1.2.0 en releases 1.3.x, lo que confundía al diagnosticar.
const appVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;

const buildId =
  process.env.RENDER_GIT_COMMIT ||
  process.env.VITE_BUILD_ID ||
  process.env.GITHUB_SHA ||
  `${appVersion}-${Date.now()}`;

const payload = {
  app: 'PALMYRA',
  version: appVersion,
  buildId: String(buildId),
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(
  path.join(publicDir, 'version.json'),
  JSON.stringify(payload, null, 2) + '\n',
  'utf8',
);

console.log(`[PALMYRA] Build ${payload.buildId} · ${payload.builtAt} · v${payload.version} (${root})`);

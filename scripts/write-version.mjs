import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.resolve('public');
const appVersion = JSON.parse(fs.readFileSync(path.resolve('app-version.json'), 'utf8')).version;

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

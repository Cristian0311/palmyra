import fs from 'node:fs';
import path from 'node:path';

const packagePath = path.resolve('package.json');
const publicDir = path.resolve('public');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const buildId =
  process.env.RENDER_GIT_COMMIT ||
  process.env.VITE_BUILD_ID ||
  process.env.GITHUB_SHA ||
  `${packageJson.version}-${Date.now()}`;

const payload = {
  app: 'PALMYRA',
  version: packageJson.version,
  buildId: String(buildId),
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(
  path.join(publicDir, 'version.json'),
  JSON.stringify(payload, null, 2) + '\n',
  'utf8',
);

console.log(`[PALMYRA] Build ${payload.buildId} · ${payload.builtAt}`);

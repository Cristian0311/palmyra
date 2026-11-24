# PALMYRA

PALMYRA is an offline-first SaaS CRM/POS for business management.

Versión actual: **1.3.5** (`package.json`). Fases F0–F7 cerradas (base local,
escritorio/LAN/licencias, nube, Android autónomo, actualizaciones firmadas,
piloto con migración guiada y rollback); **no hay despliegue público
activo**.

## Production stack
- React + Vite + TypeScript
- Express production server
- Supabase PostgreSQL, Auth, RLS and Realtime
- Local-first storage (SQLite on desktop/Android, IndexedDB on web) + durable offline outbox
- PWA with cold-start offline support
- Windows desktop (Electron), Android APK and LAN hub

## Development
```bash
npm install
npm run dev
```

## Production (web)
```bash
npm run build
npm start
```
`npm start` sirve el cliente compilado de `dist/` automáticamente; usa
`npm run dev` para el servidor con recarga en caliente.

## Admin panel
```bash
npm run build:admin   # compila la consola SaaS en dist-admin/
```

## Android
```bash
bash android/build-apk.sh
```

## Desktop (Windows)
```bash
npm run build:desktop   # app web + servidor local empaquetado en un solo archivo
npm run desktop:pack    # carpeta ejecutable en release/win-unpacked
npm run desktop:dist    # instalador NSIS en release/
```
La app instalada sirve todo desde `http://127.0.0.1:10000` y funciona sin
internet; los datos locales se sincronizan solos cuando vuelve la conexión.
El instalador se actualiza en silencio con `/S` y se registra en
`%APPDATA%/palmyra/desktop.log`.

## Quality gates
```bash
npm run lint
npm run test:unit
npm run test:integrity
npm run audit:architecture:strict
npm run drill:restore
npm run pilot:sim
npm run build
```

The repository uses **npm** as its canonical package manager. `package-lock.json` is the npm lockfile used by CI and local builds.

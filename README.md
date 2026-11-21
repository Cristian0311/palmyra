# PALMYRA

PALMYRA is an offline-first SaaS CRM/POS for business management.

## Production stack
- React + Vite + TypeScript
- Express production server
- Supabase PostgreSQL, Auth, RLS and Realtime
- IndexedDB + durable offline outbox
- PWA with cold-start offline support
- Render production deployment

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
npm run build
```

The repository uses **npm** as its canonical package manager. `package-lock.json` is the npm lockfile used by CI and Render.

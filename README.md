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

## Quality gates
```bash
npm run lint
npm run test:unit
npm run test:integrity
npm run audit:architecture:strict
npm run build
```

The repository uses **npm** as its canonical package manager. `package-lock.json` is the npm lockfile used by CI and Render.

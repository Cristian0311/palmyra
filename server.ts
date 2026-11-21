import express from 'express';
import path from 'path';
import os from 'os';
import dns from 'dns';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import { createExchangeRateProvider } from './src/services/exchangeRateProvider';

dotenv.config();

// `npm run dev` ejecuta server.ts como ESM (package.json type: module), donde
// __dirname no existe; el bundle de producción es CJS y sí lo define.
const moduleDir = typeof __dirname === 'string' ? __dirname : process.cwd();

// release/ se ignora en git para no inflar el repositorio, así que el servidor
// desplegado (Render) no tiene los binarios: si no hay artefacto local, redirige
// a los assets de nombre estable publicados en GitHub Releases.
const GITHUB_RELEASES_LATEST = 'https://github.com/Cristian0311/palmyra/releases/latest/download';
const DOWNLOAD_FALLBACKS = {
  windows: process.env.PALMYRA_WINDOWS_DOWNLOAD_URL || `${GITHUB_RELEASES_LATEST}/PALMYRA-POS-Setup.exe`,
  android: process.env.PALMYRA_ANDROID_DOWNLOAD_URL || `${GITHUB_RELEASES_LATEST}/PALMYRA-Android.apk`,
};

// Carga diferida: la app de escritorio empaqueta un único server.cjs y la IA
// solo debe inicializarse cuando el endpoint la necesita realmente.
async function createGoogleGenAIClient(apiKey: string) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 10000;
  // La app de escritorio fija HOST=127.0.0.1 para no exponer el POS a la red
  // local; los despliegues en servidor mantienen 0.0.0.0.
  const HOST = process.env.HOST || '0.0.0.0';

  app.use(express.json({ limit: '15mb' }));

  // Render termina TLS en su proxy: sin esto, req.ip es siempre la IP del
  // balanceador y los límites por IP se vuelven un cupo GLOBAL compartido por
  // todas las empresas (de ahí los "request rate limit reached").
  if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
  }

  // Production security baseline without adding another runtime dependency.
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  const requestRateLimit = new Map<string, { count: number; resetAt: number }>();
  let rateLimitSweepAt = Date.now() + 60_000;
  const consumeRateLimit = (key: string, limit: number, windowMs: number) => {
    const now = Date.now();
    // Sin poda, cada IP que pasa por /api queda en memoria para siempre.
    if (now >= rateLimitSweepAt) {
      for (const [entryKey, entry] of requestRateLimit) {
        if (entry.resetAt <= now) requestRateLimit.delete(entryKey);
      }
      rateLimitSweepAt = now + 60_000;
    }
    const current = requestRateLimit.get(key);
    if (!current || current.resetAt <= now) {
      requestRateLimit.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }
    if (current.count >= limit) return { allowed: false, remaining: 0, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
    current.count += 1;
    return { allowed: true, remaining: limit - current.count, retryAfter: 0 };
  };

  const verifyAccessToken = async (req: any): Promise<{ ok: boolean; user?: any }> => {
    const authHeader = String(req.headers.authorization || '');
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const supabaseUrl = process.env.SUPABASE_URL || 'https://hmcvujyqloyjdvngpdxz.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
    if (!accessToken || !supabaseAnonKey) return { ok: false };
    const userResponse = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: supabaseAnonKey, Authorization: 'Bearer ' + accessToken }
    }).catch(() => null);
    if (!userResponse?.ok) return { ok: false };
    return { ok: true, user: await userResponse.json().catch(() => null) };
  };

  const requireAuthenticatedRequest = async (req: any, res: any, next: any) => {
    const { ok, user } = await verifyAccessToken(req);
    if (!ok) return res.status(401).json({ success: false, error: 'Sesión no válida o expirada.' });

    const userId = String(user?.id || 'unknown');
    const limit = consumeRateLimit('ai:' + userId, 30, 60_000);
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter || 60));
      return res.status(429).json({ success: false, error: 'Demasiadas solicitudes de IA. Intenta nuevamente en unos segundos.' });
    }
    req.authenticatedUser = user;
    return next();
  };

  const rateLimitExchange = (req: any, res: any, next: any) => {
    const key = 'exchange:' + (req.ip || req.socket?.remoteAddress || 'unknown');
    const limit = consumeRateLimit(key, 60, 60_000);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter || 60));
      return res.status(429).json({ configured: true, error: 'Demasiadas consultas de tasa de cambio. Intenta nuevamente en unos segundos.' });
    }
    return next();
  };

  // AI routes are authenticated and rate-limited to prevent quota abuse.
  app.use('/api/ai-', requireAuthenticatedRequest);

  // PNG version of the official PALMYRA logo for email clients such as Gmail.
  // The PNG is generated at build time (public/palmyra-email-logo-v2.png), so
  // the packaged desktop server nunca necesita el módulo nativo sharp; solo se
  // usa como respaldo si el archivo no estuviera disponible.
  let palmyraEmailLogoBuffer: Buffer | null = null;
  app.get('/palmyra-email-logo-v2.png', async (_req, res) => {
    try {
      if (!palmyraEmailLogoBuffer) {
        const baseDirs = [moduleDir, path.join(moduleDir, '..', 'public'), path.join(process.cwd(), 'public')];
        for (const dir of baseDirs) {
          try { palmyraEmailLogoBuffer = await fs.readFile(path.join(dir, 'palmyra-email-logo-v2.png')); break; } catch { /* siguiente ruta */ }
        }
      }
      if (!palmyraEmailLogoBuffer) {
        const { default: sharp } = await import('sharp');
        const svg = await fs.readFile(path.join(moduleDir, '..', 'public', 'palmyra-logo-exact.svg'));
        palmyraEmailLogoBuffer = await sharp(svg)
          .resize({ width: 1200, withoutEnlargement: true })
          .png()
          .toBuffer();
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.send(palmyraEmailLogoBuffer);
    } catch (error) {
      console.error('[PALMYRA] No se pudo generar el logo PNG de correo:', error);
      res.status(500).type('text/plain').send('PALMYRA logo unavailable');
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });




  // Platform infrastructure usage. All provider secrets remain server-side.
  // Render resources are discovered live from the workspace API; Supabase metrics
  // are read through an admin-authorized database RPC.
  app.options('/api/platform-usage', (req, res) => {
    const allowedOrigin = 'https://palmyra-admin.onrender.com';
    const origin = String(req.headers.origin || '');
    if (origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    }
    return res.status(204).end();
  });

  app.get('/api/platform-usage', async (req, res) => {
    try {
      const allowedOrigin = 'https://palmyra-admin.onrender.com';
      const origin = String(req.headers.origin || '');
      if (origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }

      const authHeader = String(req.headers.authorization || '');
      const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const supabaseUrl = process.env.SUPABASE_URL || 'https://hmcvujyqloyjdvngpdxz.supabase.co';
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
      if (!accessToken || !supabaseAnonKey) return res.status(401).json({ error: 'Sesión administrativa no disponible.' });

      const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}` }
      });
      if (!userResponse.ok) return res.status(401).json({ error: 'Sesión administrativa inválida.' });

      const adminResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_platform_companies`, {
        method: 'POST',
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!adminResponse.ok) return res.status(403).json({ error: 'Solo el administrador de plataforma puede consultar infraestructura.' });

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const renderKey = process.env.RENDER_API_KEY || '';
      const renderWorkspaceId = process.env.RENDER_WORKSPACE_ID || 'tea-d7f95hf7f7vs739rkq2g';
      const renderHeaders = renderKey ? { Accept: 'application/json', Authorization: `Bearer ${renderKey}` } : null;

      const toNumber = (value: unknown) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };
      const seriesPoints = (payload: any) => (Array.isArray(payload) ? payload : [])
        .flatMap((item: any) => Array.isArray(item?.values) ? item.values.map((point: any) => ({
          value: Number(point?.value),
          unit: String(item?.unit || point?.unit || ''),
          timestamp: point?.timestamp
        })) : [])
        .filter((point: any) => Number.isFinite(point.value));
      const latestSeriesValue = (payload: any) => {
        const points = seriesPoints(payload).sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return points[0] || null;
      };
      const sumBandwidthGb = (payload: any) => seriesPoints(payload).reduce((total: number, point: any) => {
        const unit = point.unit.toLowerCase();
        if (unit === 'gb') return total + point.value;
        if (unit === 'mb') return total + point.value / 1024;
        if (unit === 'kb') return total + point.value / (1024 * 1024);
        if (unit === 'bytes' || unit === 'b') return total + point.value / (1024 * 1024 * 1024);
        return total + point.value;
      }, 0);

      let renderServicesUsage: any[] = [];
      let renderApiError: string | null = null;

      if (renderHeaders) {
        try {
          const servicesResponse = await fetch(
            `https://api.render.com/v1/services?ownerId=${encodeURIComponent(renderWorkspaceId)}&includePreviews=false&limit=100`,
            { headers: renderHeaders }
          );
          if (!servicesResponse.ok) throw new Error(`Render services HTTP ${servicesResponse.status}`);
          const servicesPayload = await servicesResponse.json();
          const discoveredServices = (Array.isArray(servicesPayload) ? servicesPayload : [])
            .map((entry: any) => entry?.service || entry)
            .filter((service: any) => service?.id);

          renderServicesUsage = await Promise.all(discoveredServices.map(async (service: any) => {
            const currentStart = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
            const serviceBase = new URLSearchParams({
              resource: service.id,
              startTime: monthStart,
              endTime: now.toISOString(),
              resolutionSeconds: '3600'
            });
            const currentWindow = new URLSearchParams({
              resource: service.id,
              startTime: currentStart,
              endTime: now.toISOString(),
              resolutionSeconds: '300'
            });
            try {
              const types = ['bandwidth','cpu','cpu-limit','memory','memory-limit','http-request-count'];
              const [bandwidthResponse,cpuResponse,cpuLimitResponse,memoryResponse,memoryLimitResponse,httpResponse] = await Promise.all([
                fetch(`https://api.render.com/v1/metrics/bandwidth?${serviceBase}`, {headers:renderHeaders}),
                fetch(`https://api.render.com/v1/metrics/cpu?${currentWindow}`, {headers:renderHeaders}),
                fetch(`https://api.render.com/v1/metrics/cpu-limit?${currentWindow}`, {headers:renderHeaders}),
                fetch(`https://api.render.com/v1/metrics/memory?${currentWindow}`, {headers:renderHeaders}),
                fetch(`https://api.render.com/v1/metrics/memory-limit?${currentWindow}`, {headers:renderHeaders}),
                fetch(`https://api.render.com/v1/metrics/http-request-count?${currentWindow}`, {headers:renderHeaders})
              ]);
              const [bandwidth,cpu,cpuLimit,memory,memoryLimit,httpRequests] = await Promise.all([
                bandwidthResponse.ok ? bandwidthResponse.json() : [],
                cpuResponse.ok ? cpuResponse.json() : [],
                cpuLimitResponse.ok ? cpuLimitResponse.json() : [],
                memoryResponse.ok ? memoryResponse.json() : [],
                memoryLimitResponse.ok ? memoryLimitResponse.json() : [],
                httpResponse.ok ? httpResponse.json() : []
              ]);
              const latestCpu = latestSeriesValue(cpu)?.value ?? null;
              const latestCpuLimit = latestSeriesValue(cpuLimit)?.value ?? null;
              const latestMemory = latestSeriesValue(memory);
              const latestMemoryLimit = latestSeriesValue(memoryLimit);
              const memoryMb = latestMemory ? latestMemory.value / 1024 / 1024 : null;
              const memoryLimitMb = latestMemoryLimit ? latestMemoryLimit.value / 1024 / 1024 : null;
              const serviceBandwidthGb = sumBandwidthGb(bandwidth);
              const requestPoints = seriesPoints(httpRequests);
              const requestCount6h = requestPoints.reduce((sum:number,p:any)=>sum+p.value,0);

              return {
                id: service.id,
                name: service.name || service.id,
                type: service.type || 'unknown',
                repo: service.repo || null,
                branch: service.branch || null,
                region: service.region || null,
                plan: service.serviceDetails?.plan || service.plan || service.serviceDetails?.buildPlan || null,
                url: service.serviceDetails?.url || service.url || null,
                suspended: service.suspended || null,
                autoDeploy: service.autoDeployTrigger || service.autoDeploy || null,
                bandwidthGb: serviceBandwidthGb,
                cpuCurrent: latestCpu,
                cpuLimit: latestCpuLimit,
                cpuPercent: latestCpu != null && latestCpuLimit ? Math.min(100,(latestCpu/latestCpuLimit)*100) : null,
                memoryCurrentMb: memoryMb,
                memoryLimitMb,
                memoryPercent: memoryMb != null && memoryLimitMb ? Math.min(100,(memoryMb/memoryLimitMb)*100) : null,
                requestCount6h,
                metricsAvailable: {
                  bandwidth: bandwidthResponse.ok,
                  cpu: cpuResponse.ok,
                  memory: memoryResponse.ok,
                  requests: httpResponse.ok
                },
                error: [bandwidthResponse,cpuResponse,cpuLimitResponse,memoryResponse,memoryLimitResponse,httpResponse].some((x:any)=>!x.ok)
                  ? 'Una o más métricas no están disponibles para este tipo de servicio.'
                  : null
              };
            } catch (error: any) {
              return {
                id: service.id,name:service.name || service.id,type:service.type || 'unknown',
                repo:service.repo || null,branch:service.branch || null,region:service.region || null,
                plan:service.serviceDetails?.plan || service.plan || service.serviceDetails?.buildPlan || null,
                url:service.serviceDetails?.url || service.url || null,suspended:service.suspended || null,
                autoDeploy:service.autoDeployTrigger || service.autoDeploy || null,
                bandwidthGb:null,cpuCurrent:null,cpuLimit:null,cpuPercent:null,memoryCurrentMb:null,memoryLimitMb:null,memoryPercent:null,
                requestCount6h:null,metricsAvailable:{bandwidth:false,cpu:false,memory:false,requests:false},
                error:error?.message || 'No se pudo consultar este servicio.'
              };
            }
          }));
        } catch (error: any) {
          renderApiError = error?.message || 'No se pudo enumerar Render.';
        }
      } else {
        renderApiError = 'RENDER_API_KEY no está configurada en el servidor.';
      }

      // Render outbound bandwidth is a workspace quota. Keep the documented
      // quota configurable so the UI never invents a plan-specific number.
      const renderBandwidthLimitGb = toNumber(process.env.RENDER_MONTHLY_BANDWIDTH_GB) ?? 5;
      const renderBandwidthGb = renderServicesUsage.reduce((sum, service) => sum + Number(service.bandwidthGb || 0), 0);
      const renderBandwidthAvailableGb = Math.max(0, renderBandwidthLimitGb - renderBandwidthGb);

      const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_platform_infrastructure_metrics`, {
        method:'POST',
        headers:{apikey:supabaseAnonKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
        body:'{}'
      });
      if (!supabaseResponse.ok) throw new Error(`Supabase infrastructure RPC HTTP ${supabaseResponse.status}`);
      const supabaseMetrics = await supabaseResponse.json();

      const supabase = {
        configured: true,
        plan: process.env.SUPABASE_PLAN || 'Free',
        databaseMb: Number(supabaseMetrics?.database_bytes || 0) / 1024 / 1024,
        databaseLimitMb: toNumber(process.env.SUPABASE_DATABASE_LIMIT_MB) ?? 500,
        databaseAvailableMb: Math.max(0,(toNumber(process.env.SUPABASE_DATABASE_LIMIT_MB) ?? 500) - Number(supabaseMetrics?.database_bytes || 0)/1024/1024),
        databasePercent: Math.min(100,(Number(supabaseMetrics?.database_bytes || 0)/1024/1024)/(toNumber(process.env.SUPABASE_DATABASE_LIMIT_MB) ?? 500)*100),
        activeConnections: Number(supabaseMetrics?.active_connections || 0),
        storageBytes: Number(supabaseMetrics?.storage_bytes || 0),
        storageObjects: Number(supabaseMetrics?.storage_objects || 0),
        tables: Array.isArray(supabaseMetrics?.tables) ? supabaseMetrics.tables : [],
        syncQueue: supabaseMetrics?.sync_queue || {pending:0,failed:0,conflicts:0,applied_operations:0},
        companyMetrics: Array.isArray(supabaseMetrics?.companies) ? supabaseMetrics.companies : [],
        apiRequests: null as number | null,
        apiRequestsLimit: null as number | null,
        apiRequestsSource: 'not_configured',
        error: null as string | null
      };

      const managementToken = process.env.SUPABASE_MANAGEMENT_TOKEN || '';
      if (managementToken) {
        const projectRef = process.env.SUPABASE_PROJECT_REF || 'hmcvujyqloyjdvngpdxz';
        const usageResponse = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/usage.api-requests-count?interval=1d`, {
          headers:{Accept:'application/json',Authorization:`Bearer ${managementToken}`}
        });
        if (usageResponse.ok) {
          const payload = await usageResponse.json();
          supabase.apiRequests = (payload?.result || []).reduce((total:number,row:any)=> total + Number(row?.count || 0),0);
          supabase.apiRequestsSource = 'supabase_management_api';
        } else {
          supabase.error = `Supabase Management API HTTP ${usageResponse.status}`;
        }
      }

      return res.json({
        capturedAt: now.toISOString(),
        monthStart,
        providerSources: {
          render: renderHeaders ? 'Render REST API' : 'not_configured',
          supabase: 'Supabase PostgreSQL + REST RPC',
          supabaseManagement: managementToken ? 'Supabase Management API' : 'not_configured'
        },
        render: {
          configured: Boolean(renderHeaders),
          workspaceId: renderWorkspaceId,
          bandwidthGb: renderBandwidthGb,
          bandwidthLimitGb: renderBandwidthLimitGb,
          bandwidthAvailableGb: renderBandwidthAvailableGb,
          bandwidthPercent: renderBandwidthLimitGb ? Math.min(100,(renderBandwidthGb/renderBandwidthLimitGb)*100) : null,
          services: renderServicesUsage,
          error: renderApiError
        },
        supabase,
        limits: {
          renderMonthlyBandwidthGb: renderBandwidthLimitGb,
          supabaseFreeDatabaseMb: 500
        }
      });
    } catch (error: any) {
      console.error('[PALMYRA] platform usage:', error);
      return res.status(500).json({ error: error?.message || 'No se pudo consultar el consumo real.' });
    }
  });

  const exchangeRates = createExchangeRateProvider();
  app.get('/api/exchange-rates', rateLimitExchange, async (_req, res) => {
    const result = await exchangeRates(process.env.ELTOQUE_API_TOKEN || '');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(result.status).json(result.body);
  });

  // --- Red local: presencia de equipos y nombres ----------------------------
  // El registro vive en memoria y solo persiste nombres; las IP y el último
  // contacto se reconstruyen con cada heartbeat.
  const lanDataDir = process.env.PALMYRA_DATA_DIR || path.join(os.homedir(), '.palmyra');
  const lanConfigPath = path.join(lanDataDir, 'palmyra-lan.json');
  const lanDevicesPath = path.join(lanDataDir, 'lan-devices.json');
  const lanDesktopManaged = Boolean(process.env.PALMYRA_DATA_DIR);

  const readJsonFile = async <T,>(file: string): Promise<T | null> => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; }
  };
  const writeJsonFile = async (file: string, value: unknown) => {
    try {
      await fs.mkdir(lanDataDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(value, null, 2));
    } catch (error) {
      console.warn('[PALMYRA] No se pudo guardar la configuración de red local:', error);
    }
  };

  type LanRecord = {
    id: string;
    name: string;
    kind: 'desktop' | 'mobile' | 'tablet' | 'browser';
    warehouseName: string | null;
    ip: string;
    firstSeen: string;
    lastSeen: string;
    platform?: string | null;
    model?: string | null;
    nameSource?: 'auto' | 'manual';
  };

  const lanBound = HOST !== '127.0.0.1' && HOST !== 'localhost';
  const lanConfig = (await readJsonFile<{ enabled?: boolean }>(lanConfigPath)) || {};
  // En escritorio el interruptor manda; en desarrollo el enlace depende del host.
  let lanDesired = lanDesktopManaged ? lanConfig.enabled === true : lanBound;
  const lanDevices = new Map<string, LanRecord>();
  const savedLanDevices = await readJsonFile<LanRecord[]>(lanDevicesPath);
  for (const record of Array.isArray(savedLanDevices) ? savedLanDevices : []) {
    if (!record?.id || !record?.name) continue;
    lanDevices.set(record.id, {
      ...record,
      nameSource: record.nameSource === 'manual' ? 'manual' : 'auto',
      platform: record.platform || null,
      model: record.model || null,
      lastSeen: Number.isFinite(Date.parse(record.lastSeen || '')) ? record.lastSeen : new Date(0).toISOString(),
      firstSeen: record.firstSeen || new Date().toISOString(),
      ip: ''
    });
  }

  const persistLanDevices = () => {
    lastLanPersistAt = Date.now();
    const records = [...lanDevices.values()].map(({ id, name, kind, warehouseName, firstSeen, lastSeen, platform, model, nameSource }) => ({ id, name, kind, warehouseName, firstSeen, lastSeen, platform, model, nameSource, ip: '' }));
    void writeJsonFile(lanDevicesPath, records.slice(-200));
  };
  let lastLanPersistAt = 0;

  const lanAddresses = () => {
    const addresses: string[] = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry && entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
      }
    }
    return addresses;
  };
  const lanStatus = () => {
    const addresses = lanBound ? lanAddresses() : [];
    return {
      enabled: lanBound,
      desired: lanDesired,
      desktop: lanDesktopManaged,
      host: HOST,
      port: PORT,
      addresses,
      url: lanBound && addresses[0] ? `http://${addresses[0]}:${PORT}` : null,
      requiresRestart: lanDesktopManaged && lanDesired !== lanBound
    };
  };
  const lanSnapshot = () => {
    const now = Date.now();
    const weekAgo = now - 7 * 86400000;
    const devices = [...lanDevices.values()]
      .filter(device => Date.parse(device.lastSeen || '') > weekAgo)
      .map(device => ({
        id: device.id,
        name: device.name,
        ip: device.ip,
        kind: device.kind,
        firstSeen: device.firstSeen,
        lastSeen: device.lastSeen,
        online: now - Date.parse(device.lastSeen || '') < 90_000,
        warehouseName: device.warehouseName,
        platform: device.platform || null,
        model: device.model || null,
        nameSource: device.nameSource || 'auto'
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'es'));
    return { devices, status: lanStatus(), serverNow: new Date(now).toISOString() };
  };

  const cleanLanText = (value: unknown, max = 60) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const cleanLanIp = (value: unknown) => String(value || '').replace(/^::ffff:/, '');
  const isLoopbackIp = (ip: string) => !ip || ip === '::1' || ip.startsWith('127.');
  const serverHostName = os.hostname().replace(/\.local$/i, '');
  // El nombre de una PC en la red solo se puede conocer por DNS inverso; si la
  // red no lo resuelve se usa el nombre detectado por el propio navegador.
  const reverseLanHost = async (ip: string): Promise<string> => {
    if (isLoopbackIp(ip)) return serverHostName;
    try {
      const names = await Promise.race([
        dns.promises.reverse(ip),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 1200))
      ]);
      const host = names.map(name => String(name || '').split('.')[0]).find(name => name && !/^localhost$/i.test(name));
      return host ? host.toUpperCase() : '';
    } catch {
      return '';
    }
  };
  const requireLanAdmin = async (req: any, res: any, next: any) => {
    const { ok } = await verifyAccessToken(req);
    if (!ok) return res.status(401).json({ error: 'Se requiere una sesión autenticada para administrar la red local.' });
    return next();
  };

  app.get('/api/lan/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(lanStatus());
  });

  app.post('/api/lan/presence', async (req: any, res) => {
    const key = 'lan-presence:' + (req.ip || req.socket?.remoteAddress || 'unknown');
    if (!consumeRateLimit(key, 240, 60_000).allowed) return res.status(429).json({ error: 'Demasiados latidos de presencia.' });
    const id = cleanLanText(req.body?.id, 64);
    if (!id) return res.status(400).json({ error: 'Falta el identificador del equipo.' });
    const now = new Date().toISOString();
    const existing = lanDevices.get(id);
    const kind = ['desktop', 'mobile', 'tablet', 'browser'].includes(req.body?.kind) ? req.body.kind as LanRecord['kind'] : 'browser';
    const ip = cleanLanIp(req.ip || req.socket?.remoteAddress);
    const platform = cleanLanText(req.body?.platform, 24) || null;
    const model = cleanLanText(req.body?.model, 40) || null;
    const payloadName = cleanLanText(req.body?.name);
    const fallbackName = `Equipo ${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase()}`;

    // Un nombre puesto a mano por el dueño manda siempre. Si no, se usa el
    // nombre real del equipo (hostname del PC o modelo del móvil).
    let name = existing?.nameSource === 'manual' ? existing.name : '';
    if (!name) name = await reverseLanHost(ip);
    if (!name) name = existing?.name || '';
    if (!name || /^equipo\s/i.test(name)) name = payloadName || name || fallbackName;

    lanDevices.set(id, {
      id,
      name,
      kind,
      platform,
      model,
      nameSource: existing?.nameSource === 'manual' ? 'manual' : 'auto',
      warehouseName: cleanLanText(req.body?.warehouseName, 80) || null,
      ip,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now
    });
    if (!existing) {
      if (lanDevices.size > 200) {
        const oldest = [...lanDevices.values()].sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen))[0];
        if (oldest) lanDevices.delete(oldest.id);
      }
      persistLanDevices();
    } else if (Date.now() - lastLanPersistAt > 60_000) {
      // Mantiene el último contacto en disco sin escribir en cada latido.
      persistLanDevices();
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true });
  });

  app.get('/api/lan/devices', requireLanAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(lanSnapshot());
  });

  app.patch('/api/lan/devices/:id', requireLanAdmin, (req: any, res) => {
    const id = String(req.params.id || '');
    const device = lanDevices.get(id);
    if (!device) return res.status(404).json({ error: 'Ese equipo ya no está registrado.' });
    const name = cleanLanText(req.body?.name);
    if (!name) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
    lanDevices.set(id, { ...device, name, nameSource: 'manual' });
    persistLanDevices();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(lanSnapshot());
  });

  app.delete('/api/lan/devices/:id', requireLanAdmin, (req: any, res) => {
    lanDevices.delete(String(req.params.id || ''));
    persistLanDevices();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(lanSnapshot());
  });

  app.put('/api/lan/settings', requireLanAdmin, async (req: any, res) => {
    if (!lanDesktopManaged) {
      return res.status(409).json({ error: 'El acceso LAN se administra desde el servidor donde está instalado PALMYRA.' });
    }
    const enabled = req.body?.enabled === true;
    lanDesired = enabled;
    await writeJsonFile(lanConfigPath, { enabled });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ status: lanStatus() });
  });

  // AI Financial & Operational Report Analyzer
  app.post('/api/ai-analyze-report', async (req, res) => {
    try {
      const payload = req.body || {};
      const {
        businessName = 'PALMYRA',
        dateFilterLabel = 'Todo el historial',
        baseCurrencyCode = 'CUP',
        baseCurrencySymbol = '$',
        kpis = {},
        topProducts = [],
        lowStockOrStagnant = [],
        cashSessionsDiscrepancies = [],
        currenciesSummary = []
      } = payload;

      const apiKey = process.env.GEMINI_API_KEY;

      let aiResult = null;

      if (apiKey && apiKey !== 'MY_GEMINI_API_KEY' && apiKey.trim().length > 10) {
        try {
          const ai = await createGoogleGenAIClient(apiKey);
          const prompt = `Analiza los siguientes datos financieros y operativos del negocio "${businessName}" (Filtro: ${dateFilterLabel}, Moneda base: ${baseCurrencyCode} ${baseCurrencySymbol}).
          
DATOS FINANCIEROS:
- Ventas Totales: ${kpis.totalSales || 0} ${baseCurrencyCode} (${kpis.salesCount || 0} transacciones)
- Ticket Promedio: ${kpis.avgTicket || 0} ${baseCurrencyCode}
- Entradas de Caja Extra: ${kpis.totalCashIncomes || 0}
- Egresos Operativos de Caja: ${kpis.totalCashExpenses || 0}
- Ingresos Bancarios (Transferencias/Depósitos): ${kpis.totalBankIncomes || 0}
- Egresos Bancarios: ${kpis.totalBankExpenses || 0}
- Flujo Neto Estimado: ${kpis.netFlow || 0} ${baseCurrencyCode}

TOP PRODUCTOS EN FACTURACIÓN:
${JSON.stringify(topProducts.slice(0, 6), null, 2)}

INVENTARIO ESTANCADO O BAJO STOCK:
${JSON.stringify(lowStockOrStagnant.slice(0, 6), null, 2)}

DESCUADRES Y ARQUEOS DE CAJA:
${JSON.stringify(cashSessionsDiscrepancies.slice(0, 6), null, 2)}

DESGLOSE POR MONEDA:
${JSON.stringify(currenciesSummary, null, 2)}

Genera un informe ejecutivo de auditoría contable y operativa con recomendaciones claras y datos estructurados para Excel. Responde ESTRICTAMENTE con un objeto JSON válido con esta estructura:
{
  "executiveSummary": "Un resumen ejecutivo conciso de 2-3 párrafos sobre la salud financiera y comercial del periodo.",
  "healthScore": 85,
  "topInsights": [
    "Insight 1 sobre rentabilidad y volumen",
    "Insight 2 sobre métodos de pago y transferencias",
    "Insight 3 sobre ticket promedio"
  ],
  "cashAlerts": [
    "Alerta 1 sobre arqueos de caja o cuadre",
    "Alerta 2 sobre control de efectivo vs transferencias"
  ],
  "inventoryAdvice": [
    "Consejo 1 sobre productos estrella vs estancados",
    "Consejo 2 sobre reposición y rotación de stock"
  ],
  "strategicActions": [
    "Acción prioritaria 1",
    "Acción prioritaria 2",
    "Acción prioritaria 3"
  ],
  "structuredAuditRows": [
    ["Área", "Métrica / Indicador", "Estado Actual", "Diagnóstico Operativo", "Acción Recomendada", "Prioridad"]
  ]
}`;

          const interaction = await ai.interactions.create({
            model: 'gemini-3.8-flash',
            input: prompt,
            system_instruction: 'Eres un consultor financiero y auditor contable senior especializado en retail, control de cajas POS y optimización de flujos de efectivo multimoneda.'
          });

          const resultText = interaction.output_text;
          if (resultText) {
            const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/) || resultText.match(/({[\s\S]*})/);
            const cleanJson = jsonMatch ? jsonMatch[1].trim() : resultText.trim();
            aiResult = JSON.parse(cleanJson);
          }
        } catch (geminiError) {
          console.warn('[AI Report] Gemini API call failed or timed out, falling back to smart heuristic audit:', geminiError);
        }
      }

      // If Gemini didn't run or failed, provide an intelligent rule-based audit
      if (!aiResult) {
        const sales = kpis.totalSales || 0;
        const netFlow = kpis.netFlow || 0;
        const txCount = kpis.salesCount || 0;
        const avgTicket = kpis.avgTicket || 0;
        const hasDifferences = cashSessionsDiscrepancies.some(d => Math.abs(d.discrepancy) > 1);

        const healthScore = Math.min(95, Math.max(50, 
          Math.round(75 + (sales > 0 ? 10 : 0) + (!hasDifferences ? 10 : -15))
        ));

        aiResult = {
          executiveSummary: `Durante el periodo auditado ("${dateFilterLabel}"), el negocio ${businessName} registró un volumen total facturado de ${sales.toLocaleString('es-CU')} ${baseCurrencyCode} en ${txCount} transacciones, con un ticket promedio de compra de ${avgTicket.toLocaleString('es-CU')} ${baseCurrencyCode}. El flujo neto operativo estimado se situó en ${netFlow.toLocaleString('es-CU')} ${baseCurrencyCode}. La diversificación de medios de pago entre efectivo y transferencias bancarias se mantiene activa, requiriendo supervisión constante sobre la confirmación de transferencias y la conciliación diaria de los arqueos de turno.`,
          healthScore,
          topInsights: [
            `Facturación global consolidada en ${sales.toLocaleString('es-CU')} ${baseCurrencyCode} con un promedio de ${avgTicket.toLocaleString('es-CU')} ${baseCurrencyCode} por venta.`,
            `El flujo neto operativo resultante es de ${netFlow.toLocaleString('es-CU')} ${baseCurrencyCode} tras descontar egresos operativos y pagos.`,
            currenciesSummary.length > 1 
              ? `Operación multimoneda activa en ${currenciesSummary.length} divisas, requiriendo control estricto de tasas de conversión.`
              : `Operación concentrada en ${baseCurrencyCode}, facilitando el cálculo directo de márgenes brutos.`
          ],
          cashAlerts: hasDifferences
            ? [
                `Se detectaron discrepancias en arqueos de caja en turnos cerrados. Se recomienda verificar los comprobantes físicos frente a los registros teóricos.`,
                `Asegurar que los egresos de caja por gastos operativos cuenten con recibo firmado y justificación contable.`
              ]
            : [
                `No se reportan discrepancias críticas en los arqueos de caja registrados en el periodo.`,
                `Mantener el protocolo de doble conteo al cambio de turno y registro inmediato de ingresos extraordinarios.`
              ],
          inventoryAdvice: [
            topProducts.length > 0 
              ? `El artículo líder "${topProducts[0]?.name}" representa un motor clave de ingresos; asegurar inventario de seguridad para evitar quiebres de stock.`
              : `Monitorear periódicamente los productos con mayor margen para incentivar promociones específicas.`,
            lowStockOrStagnant.length > 0
              ? `Se identificaron ${lowStockOrStagnant.length} productos con baja rotación o stock crítico que ameritan revisión comercial o descuento promocional.`
              : `Rotación de stock equilibrada según los registros de ventas del periodo.`
          ],
          strategicActions: [
            `Auditar periódicamente las conciliaciones entre el saldo bancario de Transfermóvil/EnZona y las ventas marcadas como "Transferencia".`,
            `Capacitar a los cajeros en el registro oportuno de vueltos mixtos y gastos menores de caja chica.`,
            `Ajustar los niveles de reorden en los productos estrella para maximizar el retorno sobre inventario.`
          ],
          structuredAuditRows: [
            ['Ventas y Facturación', 'Total Facturado', `${sales.toLocaleString('es-CU')} ${baseCurrencyCode}`, 'Rendimiento comercial conforme al registro de tickets', 'Mantener seguimiento de metas de ventas por turno', 'Alta'],
            ['Caja y Tesorería', 'Arqueos y Descuadres', hasDifferences ? 'Con discrepancias' : 'Cuadrado', hasDifferences ? 'Revisar cierres con diferencia negativa' : 'Auditoría de turnos limpia', 'Reforzar conciliación física al cierre', hasDifferences ? 'Urgente' : 'Media'],
            ['Cuentas Bancarias', 'Cobros por Transferencia', `${(kpis.totalBankIncomes || 0).toLocaleString('es-CU')} ${baseCurrencyCode}`, 'Pagos directos por canales digitales', 'Cruzar SMS y números de confirmación', 'Media'],
            ['Inventario y Catálogo', 'Artículos con Rotación', `${topProducts.length} productos activos`, 'Concentración de ingresos en referencias clave', 'Garantizar stock continuo de alta demanda', 'Alta'],
            ['Flujo Operativo', 'Flujo Neto Estimado', `${netFlow.toLocaleString('es-CU')} ${baseCurrencyCode}`, 'Margen operativo neto positivo del periodo', 'Optimizar control de gastos operativos de caja', 'Alta']
          ]
        };
      }

      // Sanitize and ensure complete valid structure
      const sanitizedResult = {
        executiveSummary: typeof aiResult?.executiveSummary === 'string' && aiResult.executiveSummary
          ? aiResult.executiveSummary 
          : `Auditoría contable y operativa para ${businessName}. Facturación registrada de ${(kpis?.totalSales || 0).toLocaleString('es-CU')} ${baseCurrencyCode}.`,
        healthScore: typeof aiResult?.healthScore === 'number' && !isNaN(aiResult.healthScore) 
          ? Math.max(1, Math.min(100, aiResult.healthScore)) 
          : 85,
        topInsights: Array.isArray(aiResult?.topInsights) 
          ? aiResult.topInsights.filter(Boolean) 
          : [`Facturación total registrada: ${(kpis?.totalSales || 0).toLocaleString('es-CU')} ${baseCurrencyCode}`],
        cashAlerts: Array.isArray(aiResult?.cashAlerts) 
          ? aiResult.cashAlerts.filter(Boolean) 
          : ['Verificar arqueos y comprobantes físicos de gastos operativos.'],
        inventoryAdvice: Array.isArray(aiResult?.inventoryAdvice) 
          ? aiResult.inventoryAdvice.filter(Boolean) 
          : ['Monitorear rotación de artículos de alta demanda.'],
        strategicActions: Array.isArray(aiResult?.strategicActions) 
          ? aiResult.strategicActions.filter(Boolean) 
          : ['Conciliar transferencias bancarias diariamente.'],
        structuredAuditRows: Array.isArray(aiResult?.structuredAuditRows) && aiResult.structuredAuditRows.length > 0
          ? aiResult.structuredAuditRows
          : [
              ['Ventas', 'Total Facturado', `${(kpis?.totalSales || 0).toLocaleString('es-CU')} ${baseCurrencyCode}`, 'Rendimiento comercial', 'Seguimiento continuo', 'Alta'],
              ['Caja', 'Control de Flujo', `${(kpis?.netFlow || 0).toLocaleString('es-CU')} ${baseCurrencyCode}`, 'Margen operativo neto', 'Optimizar egresos', 'Alta']
            ]
      };

      res.json({
        success: true,
        data: sanitizedResult
      });
    } catch (error: any) {
      console.error('[AI Report Error]', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Error al procesar el análisis con IA'
      });
    }
  });

  // AI Discrepancy Analyzer for Cash Closing
  app.post('/api/ai-analyze-discrepancy', async (req, res) => {
    try {
      const {
        expectedBalances = [],
        actualBalances = [],
        transactions = [],
        products = [],
        baseCurrency = { code: 'CUP', symbol: '$' }
      } = req.body;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
        return res.json({
          success: true,
          data: {
            analysis: "No se puede realizar el análisis de IA sin una clave de API válida. Por favor, verifica tu configuración.",
            suggestions: ["Verifica manualmente los tickets de venta", "Comprueba si hubo gastos no registrados"]
          }
        });
      }

      const ai = await createGoogleGenAIClient(apiKey);
      
      const sessionSummary = transactions.map((t: any) => ({
        id: t.id,
        total: t.total,
        paymentMethod: t.paymentMethod,
        items: (t.items || []).map((i: any) => `${i.quantity}x ${i.product?.name || 'Producto'}`).join(', ')
      }));

      const discrepancies = expectedBalances.map((eb: any) => {
        const actual = actualBalances.find((ab: any) => ab.currencyCode === eb.currencyCode && ab.method === eb.method)?.amount || 0;
        const diff = actual - eb.amount;
        return {
          currency: eb.currencyCode,
          method: eb.method,
          expected: eb.amount,
          actual: actual,
          difference: diff
        };
      }).filter((d: any) => Math.abs(d.difference) > 0.01);

      const productCatalogSummary = products.slice(0, 50).map((p: any) => ({
        name: p.name,
        price: p.price,
        sku: p.sku
      }));

      const prompt = `Actúa como un auditor contable experto en sistemas POS. Se ha detectado una discrepancia en el cierre de caja.
      
CONTEXTO DEL NEGOCIO:
- Moneda Base: ${baseCurrency.code} (${baseCurrency.symbol})
- Discrepancias detectadas (Diferencia = Real - Esperado):
${discrepancies.map((d: any) => `- ${d.currency} (${d.method}): Diferencia de ${d.difference.toLocaleString()} (Esperado: ${d.expected}, Real: ${d.actual})`).join('\n')}

CATÁLOGO DE PRODUCTOS (Muestra):
${JSON.stringify(productCatalogSummary, null, 2)}

ÚLTIMAS TRANSACCIONES DEL TURNO:
${JSON.stringify(sessionSummary.slice(-30), null, 2)}

TAREA:
1. Analiza las discrepancias. Si hay una diferencia NEGATIVA (falta dinero), busca productos en el catálogo cuyo precio (o suma de precios) coincida con la falta. 
2. Si hay una diferencia POSITIVA (sobra dinero), identifica si pudo ser una venta cobrada pero no registrada, o un error en el vuelto.
3. Compara los métodos de pago. A veces se marca "Efectivo" algo que fue "Transferencia".
4. Da sugerencias MUY ESPECÍFICAS. Si ves un producto que cuesta exactamente lo que falta, menciónalo explícitamente.

Responde ESTRICTAMENTE con un objeto JSON:
{
  "analysis": "Explicación técnica y lógica de la posible causa del descuadre.",
  "suggestions": [
    "Sugerencia de revisión 1",
    "Posible producto no anotado: [Nombre] ([Precio])",
    "Sugerencia de revisión 2"
  ]
}`;

      const interaction = await ai.interactions.create({
        model: 'gemini-3.8-flash',
        input: prompt,
        system_instruction: 'Eres un asistente contable de IA experto en auditoría de cajas POS. Tu objetivo es encontrar la causa raíz de los descuadres comparando montos con el catálogo de productos.'
      });

      const resultText = interaction.output_text;
      if (resultText) {
        // Handle potential markdown backticks in response
        const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/) || resultText.match(/({[\s\S]*})/);
        const cleanJson = jsonMatch ? jsonMatch[1].trim() : resultText.trim();
        res.json({
          success: true,
          data: JSON.parse(cleanJson)
        });
      } else {
        throw new Error("No response from AI");
      }
    } catch (error: any) {
      console.error('[AI Discrepancy Error]', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Error al procesar el análisis de discrepancia'
      });
    }
  });

  // AI Business Summary for Dashboard
  app.post('/api/ai-business-summary', async (req, res) => {
    try {
      const data = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      // The dashboard must remain useful even when no external AI credential is configured.
      // In that case we return a deterministic local analysis instead of an error/empty state.
      const salesToday = Number(data?.salesToday || 0);
      const txCountToday = Number(data?.txCountToday || 0);
      const lowStockCount = Number(data?.lowStockCount || 0);
      const topCategories = Array.isArray(data?.topCategories) ? data.topCategories : [];
      const currency = data?.baseCurrency || 'CUP';

      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
        const avgTicket = txCountToday > 0 ? salesToday / txCountToday : 0;
        const topCategory = topCategories[0]?.name;
        const localSummary = [
          `Ventas del día: ${salesToday.toLocaleString('es-CU')} ${currency} en ${txCountToday} ticket(s), con un promedio de ${avgTicket.toLocaleString('es-CU')} ${currency}.`,
          lowStockCount > 0
            ? `Hay ${lowStockCount} producto(s) con stock bajo que requieren revisión.`
            : 'No se reportan productos con stock bajo en los datos recibidos.',
          topCategory ? `La categoría con mayor actividad registrada es "${String(topCategory)}".` : 'No hay suficiente desglose por categorías para identificar una categoría líder.'
        ].join(' ');
        return res.json({
          success: true,
          provider: 'local-fallback',
          summary: localSummary,
          recommendations: [
            lowStockCount > 0 ? 'Revisar y reponer los productos con stock bajo.' : 'Mantener el monitoreo diario de inventario.',
            txCountToday > 0 ? 'Comparar el ticket promedio con los días anteriores.' : 'Registrar ventas durante el periodo para generar una comparación significativa.'
          ]
        });
      }

      const ai = await createGoogleGenAIClient(apiKey);
      const prompt = `
        Eres un analista de negocios experto para una tienda minorista llamada PALMYRA.
        Analiza los siguientes datos de hoy y proporciona un resumen ejecutivo MUY breve (máximo 3 oraciones) y 2 recomendaciones tácticas.
        Datos de hoy:
        - Ventas totales: ${data.salesToday} ${data.baseCurrency}
        - Cantidad de tickets: ${data.txCountToday}
        - Productos con stock bajo: ${data.lowStockCount}
        - Top categorías por venta: ${data.topCategories.map((c: any) => `${c.name}: ${c.value}`).join(", ")}

        Responde en español, con un tono profesional pero motivador.
      `;

      const interaction = await ai.interactions.create({
        model: 'gemini-3.8-flash',
        input: prompt,
      });

      res.json({
        success: true,
        summary: interaction.output_text
      });
    } catch (error: any) {
      console.error('[AI Summary Error]', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Error al procesar el resumen con IA'
      });
    }
  });

  // Descarga del instalador de escritorio para la landing. Sirve el setup más
  // reciente de release/ sin duplicar ~80 MB dentro de dist en cada compilación.
  app.get('/download/windows', async (_req, res) => {
    try {
      const releaseDirs = [
        process.env.PALMYRA_DESKTOP_RELEASE_DIR,
        path.join(process.cwd(), 'release'),
        path.join(moduleDir, '..', 'release'),
      ].filter((dir): dir is string => Boolean(dir));

      let installer = '';
      let newest = 0;
      for (const dir of releaseDirs) {
        if (!existsSync(dir)) continue;
        for (const entry of await fs.readdir(dir)) {
          if (!/^PALMYRA-POS-.+-Setup\.exe$/i.test(entry)) continue;
          const fullPath = path.join(dir, entry);
          const stats = await fs.stat(fullPath);
          if (stats.mtimeMs > newest) {
            newest = stats.mtimeMs;
            installer = fullPath;
          }
        }
      }

      if (!installer) {
        res.redirect(302, DOWNLOAD_FALLBACKS.windows);
        return;
      }
      res.download(installer, path.basename(installer));
    } catch (error: any) {
      console.error('[Download] No se pudo servir el instalador:', error?.message || error);
      res.status(500).json({ error: 'No se pudo preparar la descarga del instalador.' });
    }
  });

  // Descarga del APK de Android publicado en release/ (el más reciente).
  app.get('/download/android', async (_req, res) => {
    try {
      const releaseDirs = [
        process.env.PALMYRA_ANDROID_RELEASE_DIR,
        path.join(process.cwd(), 'release'),
        path.join(moduleDir, '..', 'release'),
      ].filter((dir): dir is string => Boolean(dir));

      let apk = '';
      let newest = 0;
      for (const dir of releaseDirs) {
        if (!existsSync(dir)) continue;
        for (const entry of await fs.readdir(dir)) {
          if (!/^PALMYRA.*\.apk$/i.test(entry)) continue;
          const fullPath = path.join(dir, entry);
          const stats = await fs.stat(fullPath);
          if (stats.mtimeMs > newest) {
            newest = stats.mtimeMs;
            apk = fullPath;
          }
        }
      }

      if (!apk) {
        res.redirect(302, DOWNLOAD_FALLBACKS.android);
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(apk)}"`);
      res.sendFile(apk);
    } catch (error: any) {
      console.error('[Download] No se pudo servir el APK:', error?.message || error);
      res.status(500).json({ error: 'No se pudo preparar la descarga de la app móvil.' });
    }
  });

  // Vite middleware in dev mode. Importado dinámicamente para que el servidor
  // de producción empaquetado no cargue (ni requiera) Vite.
  // `npm start` no define NODE_ENV: si dist/ ya está compilado servimos esos
  // estáticos en lugar de arrancar Vite en modo middleware.
  const hasBuiltClient =
    existsSync(path.join(moduleDir, 'index.html')) &&
    existsSync(path.join(moduleDir, 'assets'));
  const serveBuiltClient =
    process.env.NODE_ENV === 'production' ||
    (process.env.NODE_ENV !== 'development' && hasBuiltClient);

  if (!serveBuiltClient) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // server.cjs se empaqueta dentro de dist/, así que moduleDir es la carpeta
    // de estáticos tanto en Render como en la app de escritorio instalada.
    // process.cwd() no es fiable ahí (Electron puede arrancar con otro cwd).
    const distPath = moduleDir;

    // Never let the browser/CDN pin the service-worker entrypoint. The SW is
    // responsible for updating the cached application bundle; stale sw.js can
    // otherwise keep an old frontend running indefinitely after a deploy.
    app.get(['/sw.js', '/registerSW.js', '/manifest.webmanifest'], (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        // Never pin the HTML shell or version metadata: stale HTML can refer to
        // hashed JavaScript chunks removed by a newer deploy. Keep those entry
        // points revalidated and let the service worker manage offline assets.
        const fileName = path.basename(filePath);
        if (['index.html', 'version.json', 'sw.js', 'registerSW.js', 'manifest.webmanifest'].includes(fileName) || fileName.startsWith('workbox-')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      },
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[PALMYRA API] Server running on http://${HOST}:${PORT}`);
  });
  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    // Un puerto ocupado era invisible en la app de escritorio: quedaba una
    // ventana sin contenido. Dejamos el motivo explícito en consola/log.
    console.error(`[PALMYRA API] No se pudo abrir el puerto ${PORT}:`, error.message);
    if (error.code === 'EADDRINUSE') {
      console.error(`[PALMYRA API] El puerto ${PORT} ya está en uso por otro proceso.`);
    }
  });
}

startServer();

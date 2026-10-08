import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 10000;

  app.use(express.json({ limit: '15mb' }));

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
  const consumeRateLimit = (key: string, limit: number, windowMs: number) => {
    const now = Date.now();
    const current = requestRateLimit.get(key);
    if (!current || current.resetAt <= now) {
      requestRateLimit.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }
    if (current.count >= limit) return { allowed: false, remaining: 0, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
    current.count += 1;
    return { allowed: true, remaining: limit - current.count, retryAfter: 0 };
  };

  const requireAuthenticatedRequest = async (req: any, res: any, next: any) => {
    const authHeader = String(req.headers.authorization || '');
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const supabaseUrl = process.env.SUPABASE_URL || 'https://hmcvujyqloyjdvngpdxz.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
    if (!accessToken || !supabaseAnonKey) return res.status(401).json({ success: false, error: 'Se requiere una sesión autenticada.' });

    const userResponse = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: supabaseAnonKey, Authorization: 'Bearer ' + accessToken }
    }).catch(() => null);
    if (!userResponse?.ok) return res.status(401).json({ success: false, error: 'Sesión no válida o expirada.' });

    const user = await userResponse.json().catch(() => null);
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

  // Single, crisp PNG version of the official PALMYRA master logo for
  // email clients such as Gmail. The vector source lives in public/ and is
  // rendered server-side so email never depends on SVG support.
  let palmyraEmailLogoBuffer: Buffer | null = null;
  app.get('/palmyra-email-logo-v2.png', async (_req, res) => {
    try {
      if (!palmyraEmailLogoBuffer) {
        const svgPath = path.join(process.cwd(), 'public', 'palmyra-brand-master.svg');
        const svg = await fs.readFile(svgPath);
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

  // Informational exchange-rate proxy. The elTOQUE token never reaches the browser.
  app.get('/api/exchange-rates', rateLimitExchange, async (_req, res) => {
    try {
      const token = process.env.ELTOQUE_API_TOKEN || '';
      if (!token) {
        return res.status(503).json({
          configured: false,
          source: 'elTOQUE API',
          error: 'ELTOQUE_API_TOKEN no está configurado en el servidor.'
        });
      }
      const end = new Date();
      const start = new Date(end.getTime() - 48 * 60 * 60 * 1000);
      const formatElToqueDate = (value: Date) => value.toISOString().slice(0, 19).replace('T', ' ');
      const params = new URLSearchParams({
        date_from: formatElToqueDate(start),
        date_to: formatElToqueDate(end)
      });
      const response = await fetch(`https://tasas.eltoque.com/v1/trmi?${params.toString()}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          configured: true,
          source: 'elTOQUE API',
          error: payload?.error || `elTOQUE respondió HTTP ${response.status}`
        });
      }
      return res.json({
        configured: true,
        source: 'elTOQUE API',
        capturedAt: new Date().toISOString(),
        informationalOnly: true,
        data: payload
      });
    } catch (error: any) {
      console.error('[PALMYRA] exchange rates:', error);
      return res.status(502).json({
        configured: true,
        source: 'elTOQUE API',
        error: error?.message || 'No se pudo consultar elTOQUE.'
      });
    }
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
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              }
            }
          });
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

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
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

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      const prompt = `
        Eres un analista de negocios experto para una tienda minorista llamada MARÉ.
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

  // Vite middleware in dev mode
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    // Never let the browser/CDN pin the service-worker entrypoint. The SW is
    // responsible for updating the cached application bundle; stale sw.js can
    // otherwise keep an old frontend running indefinitely after a deploy.
    app.get(['/sw.js', '/registerSW.js', '/manifest.webmanifest'], (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[PALMYRA API] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

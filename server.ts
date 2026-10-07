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




  // Platform infrastructure usage. Secrets stay server-side; the browser only
  // receives sanitized metrics after the existing platform-admin RPC authorizes
  // the caller.
  app.get('/api/platform-usage', async (req, res) => {
    try {
      const allowedOrigin = 'https://palmyra-admin.onrender.com';
      const origin = String(req.headers.origin || '');
      if (origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();

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
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      if (!adminResponse.ok) return res.status(403).json({ error: 'Solo el administrador de plataforma puede consultar consumo.' });

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const renderKey = process.env.RENDER_API_KEY || '';
      const renderHeaders = renderKey
        ? { Accept: 'application/json', Authorization: `Bearer ${renderKey}` }
        : null;

      const renderServices = [
        { id: process.env.RENDER_SERVICE_ID || 'srv-db089k49v7es73ab7750', name: 'PALMYRA CRM', type: 'Web Service', url: 'https://palmyracrm.onrender.com' },
        { id: process.env.RENDER_ADMIN_SERVICE_ID || 'srv-db1t348u01pc73fu26j0', name: 'PALMYRA ADMIN', type: 'Static Site', url: 'https://palmyra-admin.onrender.com' },
      ];

      const sumSeries = (payload: any, unitScale = 1) =>
        (Array.isArray(payload) ? payload : []).reduce((total: number, item: any) =>
          total + (item?.values || []).reduce((sum: number, point: any) => sum + Number(point?.value || 0), 0), 0
        ) * unitScale;

      const lastSeriesValue = (payload: any) => {
        const points = (Array.isArray(payload) ? payload : [])
          .flatMap((item: any) => Array.isArray(item?.values) ? item.values : [])
          .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return points.length ? Number(points[0].value || 0) : null;
      };

      const renderServicesUsage = await Promise.all(renderServices.map(async (service) => {
        const empty = {
          ...service,
          configured: Boolean(renderHeaders),
          bandwidthGb: null as number | null,
          bandwidthLimitGb: 5,
          bandwidthAvailableGb: null as number | null,
          bandwidthPercent: null as number | null,
          cpuCurrent: null as number | null,
          cpuLimit: null as number | null,
          cpuPercent: null as number | null,
          memoryCurrentMb: null as number | null,
          memoryLimitMb: null as number | null,
          memoryPercent: null as number | null,
          error: null as string | null,
        };
        if (!renderHeaders) {
          empty.error = 'Render API no está configurada en el servidor.';
          return empty;
        }

        try {
          const base = new URLSearchParams({
            resource: service.id,
            startTime: monthStart,
            endTime: now.toISOString(),
            resolutionSeconds: '3600'
          });
          const currentWindow = new URLSearchParams({
            resource: service.id,
            startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            endTime: now.toISOString(),
            resolutionSeconds: '300'
          });

          const [bandwidthResponse, cpuResponse, cpuLimitResponse, memoryResponse, memoryLimitResponse] = await Promise.all([
            fetch(`https://api.render.com/v1/metrics/bandwidth?${base.toString()}`, { headers: renderHeaders }),
            fetch(`https://api.render.com/v1/metrics/cpu?${currentWindow.toString()}`, { headers: renderHeaders }),
            fetch(`https://api.render.com/v1/metrics/cpu?aggregationMethod=MAX&${base.toString()}`, { headers: renderHeaders }),
            fetch(`https://api.render.com/v1/metrics/memory?${currentWindow.toString()}`, { headers: renderHeaders }),
            fetch(`https://api.render.com/v1/metrics/memory?aggregationMethod=MAX&${base.toString()}`, { headers: renderHeaders })
          ]);

          const bandwidth = bandwidthResponse.ok ? await bandwidthResponse.json() : [];
          const cpu = cpuResponse.ok ? await cpuResponse.json() : [];
          const cpuLimit = cpuLimitResponse.ok ? await cpuLimitResponse.json() : [];
          const memory = memoryResponse.ok ? await memoryResponse.json() : [];
          const memoryLimit = memoryLimitResponse.ok ? await memoryLimitResponse.json() : [];

          const bandwidthGb = sumSeries(bandwidth, 1 / 1024);
          const cpuCurrent = lastSeriesValue(cpu);
          const cpuCap = lastSeriesValue(cpuLimit);
          const memoryCurrentMb = lastSeriesValue(memory) == null ? null : lastSeriesValue(memory)! / 1024 / 1024;
          const memoryCapMb = lastSeriesValue(memoryLimit) == null ? null : lastSeriesValue(memoryLimit)! / 1024 / 1024;

          empty.bandwidthGb = bandwidthGb;
          empty.bandwidthAvailableGb = Math.max(0, empty.bandwidthLimitGb - bandwidthGb);
          empty.bandwidthPercent = Math.min(100, (bandwidthGb / empty.bandwidthLimitGb) * 100);
          empty.cpuCurrent = cpuCurrent;
          empty.cpuLimit = cpuCap;
          empty.cpuPercent = cpuCurrent != null && cpuCap ? Math.min(100, (cpuCurrent / cpuCap) * 100) : null;
          empty.memoryCurrentMb = memoryCurrentMb;
          empty.memoryLimitMb = memoryCapMb;
          empty.memoryPercent = memoryCurrentMb != null && memoryCapMb ? Math.min(100, (memoryCurrentMb / memoryCapMb) * 100) : null;

          const failed = [bandwidthResponse, cpuResponse, cpuLimitResponse, memoryResponse, memoryLimitResponse].filter((response) => !response.ok);
          if (failed.length) empty.error = `Render devolvió HTTP ${failed[0].status} para una métrica.`;
        } catch (error: any) {
          empty.error = error?.message || 'No se pudo consultar Render.';
        }
        return empty;
      }));

      const renderBandwidthGb = renderServicesUsage.reduce((sum, service) => sum + Number(service.bandwidthGb || 0), 0);
      const renderBandwidthLimitGb = 5;
      const renderBandwidthAvailableGb = Math.max(0, renderBandwidthLimitGb - renderBandwidthGb);

      const supabase = {
        configured: false,
        plan: 'Free',
        databaseMb: null as number | null,
        databaseLimitMb: 500,
        databaseAvailableMb: null as number | null,
        databasePercent: null as number | null,
        apiRequests: null as number | null,
        apiRequestsLimit: null as number | null,
        error: null as string | null
      };

      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      if (serviceRoleKey) {
        supabase.configured = true;
        const dbResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/platform_database_size_bytes`, {
          method: 'POST',
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
          body: '{}'
        });
        if (dbResponse.ok) {
          const bytes = Number(await dbResponse.json());
          supabase.databaseMb = Number.isFinite(bytes) ? bytes / 1024 / 1024 : null;
          supabase.databaseAvailableMb = supabase.databaseMb == null ? null : Math.max(0, supabase.databaseLimitMb - supabase.databaseMb);
          supabase.databasePercent = supabase.databaseMb == null ? null : Math.min(100, (supabase.databaseMb / supabase.databaseLimitMb) * 100);
        } else {
          supabase.error = `Supabase database size HTTP ${dbResponse.status}`;
        }
      }

      const managementToken = process.env.SUPABASE_MANAGEMENT_TOKEN || '';
      if (managementToken) {
        supabase.configured = true;
        const projectRef = process.env.SUPABASE_PROJECT_REF || 'hmcvujyqloyjdvngpdxz';
        const usageResponse = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/usage.api-counts?interval=1d`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${managementToken}` }
        });
        if (usageResponse.ok) {
          const payload = await usageResponse.json();
          supabase.apiRequests = (payload?.result || []).reduce((total: number, row: any) =>
            total + Number(row?.total_auth_requests || 0) +
            Number(row?.total_realtime_requests || 0) +
            Number(row?.total_rest_requests || 0) +
            Number(row?.total_storage_requests || 0), 0);
        } else {
          supabase.error = supabase.error || `Supabase usage HTTP ${usageResponse.status}`;
        }
      }

      return res.json({
        capturedAt: now.toISOString(),
        monthStart,
        render: {
          configured: Boolean(renderHeaders),
          workspacePlan: 'Hobby',
          bandwidthGb: renderBandwidthGb,
          bandwidthLimitGb: renderBandwidthLimitGb,
          bandwidthAvailableGb: renderBandwidthAvailableGb,
          bandwidthPercent: Math.min(100, (renderBandwidthGb / renderBandwidthLimitGb) * 100),
          services: renderServicesUsage
        },
        supabase,
        limits: {
          renderHobbyBandwidthGb: 5,
          renderHobbyInstanceHours: 750,
          supabaseFreeDatabaseMb: 500,
          supabaseFreeEgressGb: 5
        },
        notes: [
          'El consumo de Render se consolida para PALMYRA CRM y PALMYRA ADMIN dentro del mismo workspace.',
          'CPU y memoria muestran capacidad de servicio y consumo reciente; el límite de ancho de banda es mensual.',
          'Supabase Free incluye 500 MB de base de datos por proyecto; API requests no tienen un límite mensual de solicitudes en el plan Free.'
        ]
      });
    } catch (error: any) {
      console.error('[PALMYRA] platform usage:', error);
      return res.status(500).json({ error: error?.message || 'No se pudo consultar el consumo.' });
    }
  });

  // AI Financial & Operational Report Analyzer
  app.post('/api/ai-analyze-report', async (req, res) => {
    try {
      const payload = req.body || {};
      const {
        businessName = 'MARÉ POS',
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
    console.log(`[OmniSync POS API] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

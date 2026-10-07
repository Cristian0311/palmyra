import { ArrowDownUp, Clock3, MapPin, ShieldCheck } from "lucide-react";

export default function ExchangeRate() {
  return (
    <div className="w-full min-h-full overflow-y-auto bg-primary px-3 py-4 sm:px-5 sm:py-6">
      <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-5xl items-center justify-center">
        <section className="w-full overflow-hidden rounded-[28px] border border-violet-100 bg-white shadow-xl shadow-violet-950/5">
          <div className="relative overflow-hidden bg-gradient-to-br from-violet-950 via-indigo-900 to-violet-700 px-5 py-7 text-white sm:px-8 sm:py-9">
            <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
            <div className="absolute -bottom-28 -left-10 h-52 w-52 rounded-full bg-violet-400/20 blur-3xl" />
            <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3.5">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur"><ArrowDownUp className="h-6 w-6" /></div>
                <div className="min-w-0">
                  <p className="text-[8px] font-black uppercase tracking-[0.2em] text-violet-200">PALMYRA · INFORMACIÓN</p>
                  <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">Tasa de cambio</h1>
                  <p className="mt-2 max-w-2xl text-[10px] font-semibold leading-5 text-violet-100 sm:text-xs">Próximamente podrás consultar las tasas informativas de referencia por provincia directamente desde PALMYRA.</p>
                </div>
              </div>
              <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-amber-200/20 bg-amber-300/15 px-3 py-1.5 text-[8px] font-black uppercase tracking-wider text-amber-100"><Clock3 className="h-3.5 w-3.5" /> Próximamente</span>
            </div>
          </div>
          <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_1.15fr]">
            <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-4 sm:p-5">
              <div className="flex items-center gap-2"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm"><MapPin className="h-4 w-4" /></div><div><h2 className="text-xs font-black text-violet-950">Cotización por provincia</h2><p className="mt-0.5 text-[8px] font-semibold text-violet-700/70">16 provincias de Cuba</p></div></div>
              <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">La Habana</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Artemisa</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Mayabeque</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Pinar del Río</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Matanzas</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Villa Clara</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Cienfuegos</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Sancti Spíritus</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Ciego de Ávila</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Camagüey</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Las Tunas</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Holguín</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Granma</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Santiago de Cuba</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Guantánamo</div><div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-bold text-violet-900">Isla de la Juventud</div></div>
            </div>
            <div className="flex flex-col justify-between rounded-2xl border border-base bg-secondary p-4 sm:p-5">
              <div>
                <div className="flex items-center gap-2"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><ShieldCheck className="h-4 w-4" /></div><div><h2 className="text-xs font-black text-primary">Información oficial cuando esté disponible</h2><p className="mt-0.5 text-[8px] font-semibold text-muted">Fuente externa pendiente de habilitación</p></div></div>
                <p className="mt-4 text-[9px] font-semibold leading-5 text-muted">La integración con la fuente externa está en proceso de aprobación. Hasta que el acceso oficial esté habilitado, PALMYRA no mostrará cifras simuladas ni permitirá configurar manualmente una tasa desde esta sección.</p>
              </div>
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[8px] font-bold leading-4 text-amber-800">Esta sección será exclusivamente informativa. No cambiará automáticamente precios, costos, inventario ni operaciones del CRM.</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

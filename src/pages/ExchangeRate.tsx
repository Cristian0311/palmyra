import { useMemo, useState } from "react";
import { ArrowDownUp, Calculator, Info, MapPin, RefreshCw, ShieldCheck } from "lucide-react";

const provinces = ["La Habana","Artemisa","Mayabeque","Pinar del Río","Matanzas","Villa Clara","Cienfuegos","Sancti Spíritus","Ciego de Ávila","Camagüey","Las Tunas","Holguín","Granma","Santiago de Cuba","Guantánamo","Isla de la Juventud"];

export default function ExchangeRate() {
  const [province,setProvince]=useState(provinces[0]);
  const [amount,setAmount]=useState("1");
  const [usdRate,setUsdRate]=useState("");
  const [eurRate,setEurRate]=useState("");

  const result=useMemo(()=>{
    const n=Number(amount)||0, usd=Number(usdRate)||0, eur=Number(eurRate)||0;
    return { usd:n*usd, eur:n*eur };
  },[amount,usdRate,eurRate]);

  return <div className="w-full h-full overflow-y-auto bg-primary p-3 sm:p-5">
    <div className="max-w-5xl mx-auto space-y-4">
      <header className="rounded-2xl border border-violet-100 bg-white p-4 sm:p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0"><ArrowDownUp className="w-5 h-5"/></div>
            <div><p className="text-[8px] font-black uppercase tracking-[.16em] text-violet-600">PALMYRA · INFORMACIÓN</p><h1 className="text-xl font-black text-primary">Tasa de cambio PALMYRA</h1><p className="text-[9px] font-semibold text-muted mt-1">Referencia informativa por provincia. No modifica automáticamente precios, costos ni ventas del CRM.</p></div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-100 px-2.5 py-1.5 text-[7px] font-black text-emerald-700"><ShieldCheck className="w-3 h-3"/>Solo informativa</span>
        </div>
      </header>

      <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4">
        <section className="rounded-2xl border border-base bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3"><MapPin className="w-4 h-4 text-violet-600"/><div><h2 className="text-sm font-black text-primary">Referencia por provincia</h2><p className="text-[8px] font-semibold text-muted">Selecciona la zona para consultar la tasa configurada por PALMYRA.</p></div></div>
          <select value={province} onChange={e=>setProvince(e.target.value)} className="w-full h-10 rounded-xl border border-base bg-primary px-3 text-[10px] font-bold text-primary">{provinces.map(p=><option key={p}>{p}</option>)}</select>
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            {[["USD","usdRate"],["EUR","eurRate"]].map(([currency,key])=><div key={currency} className="rounded-xl border border-base bg-primary p-3"><div className="flex items-center justify-between"><span className="text-[8px] font-black text-primary">{currency}</span><span className="text-[7px] text-muted">CUP por 1</span></div><input inputMode="decimal" value={key==="usdRate"?usdRate:eurRate} onChange={e=>key==="usdRate"?setUsdRate(e.target.value):setEurRate(e.target.value)} placeholder="Configurar tasa" className="mt-2 w-full h-8 rounded-lg border border-base bg-secondary px-2 text-[9px] font-bold text-primary"/></div>)}
          </div>
          <div className="mt-3 rounded-xl bg-violet-50 border border-violet-100 p-3 flex gap-2"><Info className="w-3.5 h-3.5 text-violet-600 shrink-0 mt-0.5"/><p className="text-[8px] leading-4 font-semibold text-violet-800">Esta pantalla no altera el precio de los productos. La tasa se utiliza únicamente como referencia para consulta y cálculo informativo.</p></div>
        </section>

        <section className="rounded-2xl border border-base bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3"><Calculator className="w-4 h-4 text-violet-600"/><div><h2 className="text-sm font-black text-primary">Conversor informativo</h2><p className="text-[8px] font-semibold text-muted">Calcula usando la tasa configurada arriba.</p></div></div>
          <label className="block text-[8px] font-black text-primary">Cantidad en moneda extranjera<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} className="mt-1.5 w-full h-10 rounded-xl border border-base bg-primary px-3 text-[10px] font-bold text-primary"/></label>
          <div className="mt-3 space-y-2">
            <div className="flex justify-between rounded-xl bg-primary border border-base p-3"><span className="text-[8px] font-bold text-muted">USD → CUP</span><strong className="text-sm text-primary">{result.usd.toLocaleString("es-CU",{maximumFractionDigits:2})} CUP</strong></div>
            <div className="flex justify-between rounded-xl bg-primary border border-base p-3"><span className="text-[8px] font-bold text-muted">EUR → CUP</span><strong className="text-sm text-primary">{result.eur.toLocaleString("es-CU",{maximumFractionDigits:2})} CUP</strong></div>
          </div>
        </section>
      </div>
    </div>
  </div>;
}

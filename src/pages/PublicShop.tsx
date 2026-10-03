import React, { useEffect, useMemo, useState } from "react";
import { Minus, Plus, QrCode, Search, ShoppingCart, Store, MapPin, Phone, MessageCircle, HelpCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useParams } from "react-router-dom";
import { loadPublicCatalog, type PublicCatalog, type PublicCatalogProduct } from "../services/publicCatalog";
import { cn } from "../lib/utils";

type CartLine = { product: PublicCatalogProduct; quantity: number };
const currencyMeta: Record<string,{symbol:string;locale:string}> = {
  CUP:{symbol:"$",locale:"es-CU"}, USD:{symbol:"$",locale:"en-US"}, EUR:{symbol:"€",locale:"de-DE"}, MN:{symbol:"$",locale:"es-CU"}
};

export default function PublicShop() {
  const { slug="" } = useParams();
  const [catalog,setCatalog]=useState<PublicCatalog|null>(null);
  const [selectedWarehouseId,setSelectedWarehouseId]=useState("");
  const [activeCategory,setActiveCategory]=useState("Todos");
  const [search,setSearch]=useState("");
  const [cart,setCart]=useState<CartLine[]>([]);
  const [tab,setTab]=useState<"catalog"|"store"|"faq">("catalog");
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [orderCode,setOrderCode]=useState("");

  useEffect(()=>{
    let alive=true; setLoading(true); setError("");
    loadPublicCatalog(slug).then(data=>{
      if(!alive)return; setCatalog(data); setSelectedWarehouseId(data.warehouses[0]?.id||"");
    }).catch(err=>alive&&setError(err?.message||"No se pudo cargar la tienda."))
      .finally(()=>alive&&setLoading(false));
    return()=>{alive=false};
  },[slug]);

  const categories=useMemo(()=>{
    if(!catalog)return [];
    return Array.from(new Map(catalog.products.filter(p=>p.category_name.toLowerCase()!=="test")
      .map(p=>[p.category_id||p.category_name,{id:p.category_id||p.category_name,name:p.category_name}])).values())
      .sort((a,b)=>a.name.localeCompare(b.name));
  },[catalog]);

  const visibleProducts=useMemo(()=>{
    if(!catalog)return [];
    const q=search.trim().toLowerCase();
    return catalog.products.filter(p=>p.category_name.toLowerCase()!=="test")
      .filter(p=>activeCategory==="Todos"||(p.category_id||p.category_name)===activeCategory)
      .filter(p=>!q||p.name.toLowerCase().includes(q)||p.sku.toLowerCase().includes(q))
      .map(p=>({...p,totalStock:(p.availability||[]).find(a=>a.warehouse_id===selectedWarehouseId)?.quantity||0}))
      .sort((a,b)=>Number(b.totalStock>0)-Number(a.totalStock>0)||a.name.localeCompare(b.name));
  },[catalog,activeCategory,search,selectedWarehouseId]);

  const currency=currencyMeta[catalog?.company.currency_code||"CUP"]||currencyMeta.CUP;
  const formatMoney=(v:number)=>currency.symbol+" "+v.toLocaleString(currency.locale,{minimumFractionDigits:2,maximumFractionDigits:2});
  const addToCart=(product:PublicCatalogProduct)=>setCart(prev=>{
    const existing=prev.find(l=>l.product.id===product.id);
    return existing?prev.map(l=>l.product.id===product.id?{...l,quantity:l.quantity+1}:l):[...prev,{product,quantity:1}];
  });
  const changeQty=(id:string,delta:number)=>setCart(prev=>prev.map(l=>l.product.id===id?{...l,quantity:Math.max(0,l.quantity+delta)}:l).filter(l=>l.quantity>0));
  const cartTotal=cart.reduce((s,l)=>s+l.product.price*l.quantity,0);
  const cartCount=cart.reduce((s,l)=>s+l.quantity,0);
  const createOrder=()=>{
    if(!catalog||!selectedWarehouseId||!cart.length)return;
    setOrderCode("APP_ORDER:"+JSON.stringify({
      version:2,companyId:catalog.company.id,companySlug:catalog.company.slug,
      warehouseId:selectedWarehouseId,i:cart.map(l=>({id:l.product.id,q:l.quantity}))
    }));
    setCart([]);
  };

  if(loading)return <main className="min-h-screen bg-slate-50 flex items-center justify-center"><div className="text-sm font-bold text-slate-500">Cargando tienda...</div></main>;
  if(error||!catalog)return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-5"><div className="max-w-md w-full rounded-3xl bg-white border border-slate-200 shadow-lg p-8 text-center"><Store className="w-10 h-10 mx-auto text-slate-400"/><h1 className="text-xl font-black text-slate-950 mt-4">Tienda no disponible</h1><p className="text-sm text-slate-500 mt-2">{error||"No encontramos esta tienda."}</p></div></main>;

  if(orderCode)return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4"><div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-xl p-7 text-center"><QrCode className="w-12 h-12 mx-auto text-slate-900"/><h1 className="text-2xl font-black text-slate-950 mt-4">Pedido listo</h1><p className="text-sm text-slate-500 mt-2">Muestra este QR al cajero. El código queda ligado a esta empresa y almacén.</p><div className="bg-white border border-slate-200 rounded-2xl p-5 mt-6 inline-flex"><QRCodeSVG value={orderCode} size={230} level="H"/></div>{catalog.config.whatsapp_number&&<button onClick={()=>window.open("https://wa.me/"+catalog.config.whatsapp_number.replace(/[^0-9]/g,"")+"?text="+encodeURIComponent("Hola, tengo un pedido generado en "+catalog.company.name+"."),"_blank")} className="w-full h-11 mt-5 rounded-xl bg-emerald-600 text-white font-bold flex items-center justify-center gap-2"><MessageCircle className="w-4 h-4"/>Enviar por WhatsApp</button>}<button onClick={()=>setOrderCode("")} className="w-full h-11 mt-2 rounded-xl bg-slate-950 text-white font-bold">Nueva orden</button></div></main>;

  return <div className="min-h-screen bg-white text-slate-900">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur px-4 sm:px-8 py-4"><div className="max-w-7xl mx-auto flex items-center justify-between gap-4"><div className="flex items-center gap-3 min-w-0"><div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white" style={{backgroundColor:catalog.config.theme_color||"#0f172a"}}><Store className="w-5 h-5"/></div><div className="min-w-0"><h1 className="font-black text-base truncate">{catalog.company.name}</h1><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-black">Tienda en línea</p></div></div><div className="flex items-center gap-2">{catalog.warehouses.length>1&&<select value={selectedWarehouseId} onChange={e=>{setSelectedWarehouseId(e.target.value);setCart([])}} className="hidden sm:block h-10 rounded-xl border border-slate-200 px-3 text-sm font-bold">{catalog.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select>}<button onClick={()=>document.getElementById("public-cart")?.scrollIntoView({behavior:"smooth"})} className="h-10 px-3 rounded-xl border border-slate-200 font-bold text-sm"><ShoppingCart className="w-4 h-4 inline mr-1"/>{cartCount}</button></div></div></header>
    <main className="max-w-7xl mx-auto p-4 sm:p-8">
      <div className="flex gap-2 overflow-x-auto pb-4 border-b border-slate-200">{([["catalog","Catálogo"],["store","Tienda"],["faq","Ayuda"]] as const).map(([k,l])=><button key={k} onClick={()=>setTab(k)} className={cn("px-4 py-2.5 rounded-xl text-sm font-bold",tab===k?"bg-slate-950 text-white":"bg-slate-100 text-slate-600")}>{l}</button>)}</div>
      {tab==="catalog"&&<>
        <section className="mt-5 rounded-3xl p-6 sm:p-10 text-white" style={{backgroundColor:catalog.config.theme_color||"#0f172a"}}><p className="text-xs font-black uppercase tracking-[0.2em] opacity-70">{catalog.company.name}</p><h2 className="text-3xl sm:text-5xl font-black mt-2 max-w-3xl whitespace-pre-wrap">{catalog.config.banner_text||"Descubre nuestros productos"}</h2><div className="relative max-w-2xl mt-7"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5"/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por nombre o SKU..." className="w-full h-12 rounded-xl pl-12 pr-4 text-slate-900 outline-none"/></div></section>
        {catalog.warehouses.length>1&&<div className="sm:hidden mt-4"><select value={selectedWarehouseId} onChange={e=>{setSelectedWarehouseId(e.target.value);setCart([])}} className="w-full h-11 rounded-xl border border-slate-200 px-3 font-bold">{catalog.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
        <div className="flex gap-2 overflow-x-auto py-5"><button onClick={()=>setActiveCategory("Todos")} className={cn("px-4 py-2 rounded-full text-xs font-bold whitespace-nowrap",activeCategory==="Todos"?"bg-slate-950 text-white":"bg-slate-100 text-slate-600")}>Todos</button>{categories.map(c=><button key={c.id} onClick={()=>setActiveCategory(c.id)} className={cn("px-4 py-2 rounded-full text-xs font-bold whitespace-nowrap",activeCategory===c.id?"bg-slate-950 text-white":"bg-slate-100 text-slate-600")}>{c.name}</button>)}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">{visibleProducts.map(product=>{const out=product.totalStock<=0;return <article key={product.id} className="rounded-3xl border border-slate-200 bg-white overflow-hidden shadow-sm flex flex-col"><div className="aspect-[4/5] bg-slate-100 overflow-hidden">{product.image_path?<img src={product.image_path} alt={product.name} className="w-full h-full object-cover" loading="lazy"/>:<div className="w-full h-full flex items-center justify-center text-5xl font-black text-slate-300">{product.name.charAt(0)}</div>}</div><div className="p-4 flex-1 flex flex-col"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{product.category_name}</p><h3 className="font-black text-sm mt-1 line-clamp-2">{product.name}</h3><p className="text-xs text-slate-500 mt-1">SKU: {product.sku}</p>{catalog.config.show_prices?<p className="text-lg font-black mt-auto pt-4">{formatMoney(product.price)}</p>:<p className="text-sm font-bold text-emerald-600 mt-auto pt-4">Consultar precio</p>}<button onClick={()=>!out&&addToCart(product)} disabled={out} className={cn("w-full h-10 mt-3 rounded-xl font-bold text-sm",out?"bg-slate-100 text-slate-400":"bg-slate-950 text-white")}>{out?"Agotado":"Agregar"}</button></div></article>})}</div>
      </>}
      {tab==="store"&&<section className="max-w-3xl mx-auto py-12"><h2 className="text-3xl font-black">{catalog.company.name}</h2><p className="text-slate-500 mt-2">Disponibilidad y pedidos de esta empresa.</p><div className="grid sm:grid-cols-2 gap-3 mt-7">{catalog.warehouses.map(w=><div key={w.id} className="p-4 rounded-2xl border border-slate-200 bg-slate-50"><MapPin className="w-5 h-5"/><p className="font-black mt-2">{w.name}</p><p className="text-xs text-slate-500 mt-1">Código: {w.code}</p></div>)}</div>{catalog.config.whatsapp_number&&<a href={"https://wa.me/"+catalog.config.whatsapp_number.replace(/[^0-9]/g,"")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 mt-6 h-11 px-4 rounded-xl bg-emerald-600 text-white font-bold"><Phone className="w-4 h-4"/>Contactar</a>}</section>}
      {tab==="faq"&&<section className="max-w-3xl mx-auto py-12"><HelpCircle className="w-8 h-8"/><h2 className="text-3xl font-black mt-4">Preguntas frecuentes</h2><div className="space-y-3 mt-6"><div className="p-4 rounded-2xl bg-slate-50 border border-slate-200"><b>¿La disponibilidad es por almacén?</b><p className="text-sm text-slate-500 mt-1">Sí. La existencia se consulta por almacén.</p></div><div className="p-4 rounded-2xl bg-slate-50 border border-slate-200"><b>¿Cómo entrego mi pedido?</b><p className="text-sm text-slate-500 mt-1">Muestra el QR generado al cajero para convertirlo en una venta.</p></div></div></section>}
      {cart.length>0&&<section id="public-cart" className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:w-[420px] z-40 rounded-3xl bg-slate-950 text-white shadow-2xl p-5"><div className="flex items-center justify-between gap-3"><div><p className="font-black">Tu pedido</p><p className="text-xs text-slate-400">{cartCount} artículos · {formatMoney(cartTotal)}</p></div><button onClick={()=>setCart([])} className="text-xs text-slate-400">Vaciar</button></div><div className="mt-4 max-h-44 overflow-y-auto space-y-2">{cart.map(line=><div key={line.product.id} className="flex items-center justify-between gap-3 bg-white/5 rounded-xl p-3"><p className="text-xs font-bold flex-1 truncate">{line.product.name}</p><div className="flex items-center gap-2"><button onClick={()=>changeQty(line.product.id,-1)} className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center"><Minus className="w-3 h-3"/></button><span className="text-xs font-black w-5 text-center">{line.quantity}</span><button onClick={()=>changeQty(line.product.id,1)} className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center"><Plus className="w-3 h-3"/></button></div></div>)}</div><button onClick={createOrder} className="w-full h-11 mt-4 rounded-xl bg-white text-slate-950 font-black">Generar QR del pedido</button></section>}
    </main>
  </div>;
}

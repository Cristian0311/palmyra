import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStore } from "../../store/useStore";
import { getAccessiblePalmiTourSteps } from "./palmiGuideSteps";
import { PalmiMascot } from "./PalmiMascot";
import "./palmiGuide.css";

const KEY = "palmyra-palmi-guide-v2";
const EDGE = 22;

type Position = { left:number; top:number };
function clamp(pos:Position):Position {
  if (typeof window === "undefined") return pos;
  return { left:Math.max(8,Math.min(pos.left,window.innerWidth-86)), top:Math.max(8,Math.min(pos.top,window.innerHeight-86)) };
}
function readPosition():Position|null {
  try { const raw=localStorage.getItem(KEY+":position"); if(!raw)return null; const p=JSON.parse(raw) as Position; return Number.isFinite(p.left)&&Number.isFinite(p.top)?clamp(p):null; } catch { return null; }
}
function autoDismissed():boolean {
  try { return localStorage.getItem(KEY+":auto-open")==="dismissed" || Boolean(localStorage.getItem(KEY+":completed")); } catch { return false; }
}

export default function PalmiGuide() {
  const currentUser = useStore(s=>s.currentUser);
  const darkMode = useStore(s=>s.storeConfig.darkMode);
  const steps = useMemo(()=>getAccessiblePalmiTourSteps(currentUser),[currentUser]);
  const navigate=useNavigate(); const location=useLocation();
  const [open,setOpen]=useState(false); const [index,setIndex]=useState(0); const [rect,setRect]=useState<DOMRect|null>(null); const [position,setPosition]=useState<Position|null>(()=>readPosition());
  const drag=useRef({active:false,moved:false,pointerId:-1,offsetX:0,offsetY:0,originX:0,originY:0,latest:null as Position|null});
  const anchor=useRef<HTMLDivElement|null>(null);
  const step=steps[index]||steps[0]; const last=index===steps.length-1; const progress=steps.length>1?((index+1)/steps.length)*100:100;

  useEffect(()=>{ if(index>=steps.length)setIndex(Math.max(0,steps.length-1)); },[index,steps.length]);

  const locate=useCallback(()=>{
    if(!open||!step?.selector){setRect(null);return;}
    let n=0; let cancelled=false;
    const loop=()=>{
      if(cancelled)return;
      const target=document.querySelector<HTMLElement>(step.selector||"");
      if(target){ target.scrollIntoView({behavior:"smooth",block:"center",inline:"nearest"}); window.setTimeout(()=>{if(!cancelled)setRect(target.getBoundingClientRect())},220); return; }
      if(++n<20)window.setTimeout(loop,90); else setRect(null);
    };
    loop(); return ()=>{cancelled=true};
  },[open,step?.selector]);

  useEffect(()=>locate(),[locate,location.pathname]);
  useEffect(()=>{
    if(!open)return;
    const refresh=()=>{const target=step?.selector?document.querySelector<HTMLElement>(step.selector):null;setRect(target?.getBoundingClientRect()||null)};
    window.addEventListener("resize",refresh); window.addEventListener("scroll",refresh,true);
    return()=>{window.removeEventListener("resize",refresh);window.removeEventListener("scroll",refresh,true)};
  },[open,step?.selector]);

  useEffect(()=>{
    if(!currentUser||autoDismissed()||steps.length<2)return;
    const timer=window.setTimeout(()=>setOpen(true),1100); return()=>window.clearTimeout(timer);
  },[currentUser?.id,steps.length]);

  useEffect(()=>{
    const openFromShell=()=>setOpen(true);
    window.addEventListener("palmyra:open-guide",openFromShell);
    return()=>window.removeEventListener("palmyra:open-guide",openFromShell);
  },[]);

  const go=(next:number)=>{
    const safe=Math.max(0,Math.min(next,steps.length-1)); setIndex(safe);
    const nextStep=steps[safe];
    if(nextStep?.path&&nextStep.path!==location.pathname)navigate(nextStep.path);
  };
  const finish=()=>{try{localStorage.setItem(KEY+":completed",new Date().toISOString())}catch{} setOpen(false);setRect(null)};
  const skipAuto=()=>{try{localStorage.setItem(KEY+":auto-open","dismissed")}catch{} setOpen(false);setRect(null)};
  const reset=()=>{try{localStorage.removeItem(KEY+":auto-open");localStorage.removeItem(KEY+":completed")}catch{} setIndex(0);setOpen(true)};
  const onDown=(e:React.PointerEvent<HTMLDivElement>)=>{
    const r=anchor.current?.getBoundingClientRect(); if(!r)return;
    drag.current={active:true,moved:false,pointerId:e.pointerId,offsetX:e.clientX-r.left,offsetY:e.clientY-r.top,originX:r.left,originY:r.top,latest:null};
    anchor.current?.setPointerCapture?.(e.pointerId); e.preventDefault();
  };
  const onMove=(e:React.PointerEvent<HTMLDivElement>)=>{
    const d=drag.current;if(!d.active||d.pointerId!==e.pointerId)return;
    const p=clamp({left:e.clientX-d.offsetX,top:e.clientY-d.offsetY});
    if(Math.abs(p.left-d.originX)>4||Math.abs(p.top-d.originY)>4)d.moved=true;
    d.latest=p;
    setPosition(p);
  };
  const onUp=(e:React.PointerEvent<HTMLDivElement>)=>{
    const d=drag.current;if(!d.active||d.pointerId!==e.pointerId)return;d.active=false;
    try{anchor.current?.releasePointerCapture?.(e.pointerId)}catch{}
    if(!d.moved)setOpen(v=>!v); else if(d.latest) try{localStorage.setItem(KEY+":position",JSON.stringify(d.latest))}catch{}
  };

  if(!currentUser||steps.length===0)return null;
  const style=position?{left:position.left,top:position.top}:{right:EDGE,bottom:EDGE};

  return <div className="palmi-guide-root">
    {open&&rect&&<div className="palmi-guide-spotlight" style={{top:Math.max(6,rect.top-5),left:Math.max(6,rect.left-5),width:Math.min(window.innerWidth-12,rect.width+10),height:Math.min(window.innerHeight-12,rect.height+10)}} aria-hidden="true"/>}
    <div ref={anchor} className="palmi-guide-anchor" style={style as React.CSSProperties}>
      {open&&<div className={"palmi-guide-panel"+(darkMode?" dark":"")} role="dialog" aria-label="Guía interactiva de PALMYRA">
        <div className="palmi-guide-header">
          <div className="palmi-guide-header-copy"><p className="palmi-guide-eyebrow">{step.eyebrow}</p><h2 className="palmi-guide-title">{step.title}</h2></div>
          <button type="button" className="palmi-guide-close" onClick={()=>setOpen(false)} aria-label="Cerrar guía"><X size={17}/></button>
        </div>
        <div className="palmi-guide-body">
          <div className="palmi-guide-progress"><div className="palmi-guide-progress-track"><div className="palmi-guide-progress-fill" style={{width:progress+"%"}}/></div><span className="palmi-guide-step-count">{index+1}/{steps.length}</span></div>
          <div className="palmi-guide-message">{step.message}</div>
          {step.tip&&<div className="palmi-guide-tip"><strong>Consejo:</strong> {step.tip}</div>}
        </div>
        <div className="palmi-guide-footer">
          <button type="button" className="palmi-guide-secondary" onClick={skipAuto}>No mostrar automáticamente</button>
          <div className="palmi-guide-actions">
            <button type="button" className="palmi-guide-icon-btn" onClick={()=>go(index-1)} disabled={index===0} aria-label="Paso anterior"><ChevronLeft size={16}/></button>
            {last?<button type="button" className="palmi-guide-primary" onClick={finish}>Terminar</button>:<button type="button" className="palmi-guide-primary" onClick={()=>go(index+1)}>Siguiente <ChevronRight size={15}/></button>}
          </div>
        </div>
      </div>}
      <div className="palmi-guide-drag-handle" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKeyDown} aria-label="Mover a Palmi o abrir la guía" role="button" tabIndex={0}>
        <PalmiMascot className="palmi-guide-mascot"/>
      </div>
      {open&&<button type="button" className="palmi-guide-reset" onClick={reset} aria-label="Reiniciar guía" title="Reiniciar guía"><RotateCcw size={13}/></button>}
    </div>
  </div>;
}

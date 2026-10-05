import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, RotateCcw, Sparkles, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useStore } from "../../store/useStore";
import { getAccessibleNumaTourSteps, type NumaTourStep } from "./palmiGuideSteps";
import { PalmiMascot } from "./PalmiMascot";
import "./palmiGuide.css";
import PWAInstallPrompt from "./PWAInstallPrompt";

const KEY = "palmyra-palmi-guide-v5";
const EDGE = 20;
type Position = { left:number; top:number };
type Phase = "action" | "explain";

function clamp(pos:Position){
  if(typeof window==="undefined")return pos;
  const width=window.innerWidth<641?68:82, height=window.innerWidth<641?96:112;
  return {left:Math.max(8,Math.min(pos.left,window.innerWidth-width-8)),top:Math.max(8,Math.min(pos.top,window.innerHeight-height-8))};
}
function readPosition():Position|null{
  try{const raw=localStorage.getItem(KEY+":position");if(!raw)return null;const p=JSON.parse(raw) as Position;return Number.isFinite(p.left)&&Number.isFinite(p.top)?clamp(p):null}catch{return null}
}
function autoDismissed(){
  try{return localStorage.getItem(KEY+":auto-open")==="dismissed"||Boolean(localStorage.getItem(KEY+":completed"))}catch{return false}
}
function findTarget(selectors:string[]|undefined){
  if(!selectors?.length)return null;
  for(const selector of selectors){try{const t=document.querySelector<HTMLElement>(selector);if(t)return t}catch{}}
  return null;
}
function selectorsFor(step:NumaTourStep|undefined,phase:Phase){
  if(!step)return [];
  if(phase==="action"&&step.navSelector)return [step.navSelector];
  if(phase==="explain"&&step.selector)return step.selector.split(",").map(s=>s.trim()).filter(Boolean);
  return [];
}

export default function PalmiGuide(){
  const currentUser=useStore(s=>s.currentUser);
  const darkMode=useStore(s=>s.storeConfig.darkMode);
  const [isMobile,setIsMobile]=useState(()=>typeof window!=="undefined"&&window.matchMedia("(max-width: 720px)").matches);
  useEffect(()=>{const media=window.matchMedia("(max-width: 720px)");const onChange=()=>setIsMobile(media.matches);onChange();media.addEventListener?.("change",onChange);return()=>media.removeEventListener?.("change",onChange)},[]);
  const steps=useMemo(()=>getAccessibleNumaTourSteps(currentUser,isMobile),[currentUser,isMobile]);
  const location=useLocation();
  const [open,setOpen]=useState(false),[index,setIndex]=useState(0),[phase,setPhase]=useState<Phase>("explain"),[rect,setRect]=useState<DOMRect|null>(null),[position,setPosition]=useState<Position|null>(()=>readPosition()),[showInstallPrompt,setShowInstallPrompt]=useState(false);
  const anchor=useRef<HTMLDivElement|null>(null);
  const drag=useRef({active:false,moved:false,pointerId:-1,offsetX:0,offsetY:0,originX:0,originY:0,latest:null as Position|null});
  const step=steps[index]||steps[0];
  const last=index===steps.length-1;
  const isActionStep=Boolean(step?.requiresAction&&phase==="action"&&step.navSelector);
  const progress=steps.length>1?((index+1)/steps.length)*100:100;

  useEffect(()=>{if(index>=steps.length)setIndex(Math.max(0,steps.length-1))},[index,steps.length]);

  const locate=useCallback((wantedPhase:Phase)=>{
    if(!open||!step){setRect(null);return;}
    const selectors=selectorsFor(step,wantedPhase);if(!selectors.length){setRect(null);return;}
    let attempts=0,cancelled=false;
    const poll=()=>{
      if(cancelled)return;
      let target=findTarget(selectors);
      if(target){
        if(wantedPhase==="explain" && /^(H1|H2|H3)$/.test(target.tagName)) target=target.parentElement || target;
        if(wantedPhase==="explain")target.scrollIntoView({behavior:"smooth",block:"nearest",inline:"nearest"});
        window.setTimeout(()=>{if(!cancelled)setRect(target!.getBoundingClientRect())},wantedPhase==="explain"?240:80);
        return;
      }
      if(++attempts<35)window.setTimeout(poll,90);else setRect(null);
    };
    poll();
    return()=>{cancelled=true};
  },[open,step]);

  useEffect(()=>locate(phase),[locate,phase,location.pathname]);

  useEffect(()=>{
    if(!open)return;
    const refresh=()=>{let t=findTarget(selectorsFor(step,phase));if(t&&phase==="explain"&&/^(H1|H2|H3)$/.test(t.tagName))t=t.parentElement||t;setRect(t?.getBoundingClientRect()||null)};
    window.addEventListener("resize",refresh);window.addEventListener("scroll",refresh,true);
    return()=>{window.removeEventListener("resize",refresh);window.removeEventListener("scroll",refresh,true)};
  },[open,step,phase]);

  useEffect(()=>{
    if(!currentUser||autoDismissed()||steps.length<2)return;
    const timer=window.setTimeout(()=>{setIndex(0);setPhase("explain");setOpen(true)},900);
    return()=>window.clearTimeout(timer);
  },[currentUser?.id,steps.length]);

  useEffect(()=>{
    const onOpen=()=>{setIndex(0);setPhase("explain");setOpen(true)};
    window.addEventListener("palmyra:open-guide",onOpen);
    return()=>window.removeEventListener("palmyra:open-guide",onOpen);
  },[]);

  useEffect(()=>{
    if(!open||!isActionStep||!step?.navSelector)return;
    const selector=step.navSelector;
    const onClick=(event:MouseEvent)=>{
      const target=event.target;if(!(target instanceof Element)||!target.closest(selector))return;
      window.setTimeout(()=>{
        if(step.id==="open-menu"){
          const next=index+1;
          setIndex(Math.min(next,steps.length-1));
          setPhase("action");
        }else{
          setPhase("explain");
        }
        setRect(null);
      },240);
    };
    document.addEventListener("click",onClick,true);
    return()=>document.removeEventListener("click",onClick,true);
  },[open,isActionStep,step?.id,step?.navSelector,index,steps.length]);

  const goNext=()=>{
    if(isActionStep)return;
    let next=index+1;
    setIndex(Math.min(next,steps.length-1));
    const targetStep=steps[Math.min(next,steps.length-1)];
    setPhase(targetStep?.requiresAction&&targetStep?.navSelector?"action":"explain");
    setRect(null);
  };
  const goPrevious=()=>{
    if(index===0)return;
    const prev=index-1;setIndex(prev);setPhase(steps[prev]?.requiresAction&&steps[prev]?.navSelector?"action":"explain");setRect(null);
  };
  const finish=()=>{try{localStorage.setItem(KEY+":completed",new Date().toISOString())}catch{}setOpen(false);setRect(null);setShowInstallPrompt(true)};
  const close=()=>{setOpen(false);setRect(null)};
  const closeInstallPrompt=useCallback(()=>setShowInstallPrompt(false),[]);
  const reset=()=>{try{localStorage.removeItem(KEY+":auto-open");localStorage.removeItem(KEY+":completed")}catch{}setIndex(0);setPhase("explain");setOpen(true)};

  const dockRef=useRef<HTMLDivElement|null>(null);
  const onDown=(e:React.PointerEvent<HTMLDivElement>)=>{
    const r=dockRef.current?.getBoundingClientRect();if(!r)return;
    drag.current={active:true,moved:false,pointerId:e.pointerId,offsetX:e.clientX-r.left,offsetY:e.clientY-r.top,originX:r.left,originY:r.top,latest:null};
    e.currentTarget.setPointerCapture?.(e.pointerId);e.preventDefault();
  };
  const onMove=(e:React.PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d.active||d.pointerId!==e.pointerId)return;const p=clamp({left:e.clientX-d.offsetX,top:e.clientY-d.offsetY});if(Math.abs(p.left-d.originX)>4||Math.abs(p.top-d.originY)>4)d.moved=true;d.latest=p;setPosition(p)};
  const onUp=(e:React.PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d.active||d.pointerId!==e.pointerId)return;d.active=false;try{e.currentTarget.releasePointerCapture?.(e.pointerId)}catch{}if(!d.moved)setOpen(true);else if(d.latest)try{localStorage.setItem(KEY+":position",JSON.stringify(d.latest))}catch{}};
  const onKeyDown=(e:React.KeyboardEvent<HTMLDivElement>)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setOpen(true)}};

  if(!currentUser||steps.length===0)return null;
  const anchorStyle=position?{left:position.left,top:position.top}:{right:EDGE,bottom:EDGE};
  const helpLabel=isActionStep?"Tu turno":"Ayuda contextual";

  return <div className="palmi-guide-root">
    {open&&rect&&<div className={"palmi-guide-spotlight "+(isActionStep?"is-command":"is-content")} style={{top:Math.max(4,rect.top-7),left:Math.max(4,rect.left-7),width:Math.min(window.innerWidth-8,rect.width+14),height:Math.min(window.innerHeight-8,rect.height+14)}} aria-hidden="true"/>}
    {open&&rect&&isActionStep&&<div className="palmi-action-cue" style={{top:Math.max(10,rect.top-44),left:Math.max(8,Math.min(rect.left,window.innerWidth-150))}} aria-hidden="true"><span className="palmi-action-cue-label">PRESIONA AQUÍ</span><span className="palmi-action-cue-arrow">↓</span></div>}
    <div ref={anchor} className={"palmi-guide-anchor "+(!position?"is-edge":"")} style={anchorStyle as React.CSSProperties}>
      {open&&<div className={"palmi-guide-panel "+(darkMode?"dark ":"")+(isActionStep?"is-command":"is-explain")} role="dialog" aria-label="Guía interactiva de Numa para PALMYRA" aria-live="polite">
        <div className="palmi-guide-brandbar"><div className="palmi-guide-brand"><div className="palmi-guide-brand-orb"><Sparkles className="w-3.5 h-3.5"/></div><div><p>PALMYRA · NUMA</p><span>Guía paso a paso</span></div></div><button type="button" className="palmi-guide-close" onClick={close} aria-label="Cerrar guía"><X size={16}/></button></div>
        <div className="palmi-guide-hero"><div className="palmi-guide-mini-mascot"><PalmiMascot className="palmi-guide-mascot-small"/></div><div className="min-w-0"><p className="palmi-guide-eyebrow">{step?.eyebrow}</p><h2 className="palmi-guide-title">{isActionStep?(step?.actionTitle||"Tu turno"):step?.title}</h2><p className="palmi-guide-current">{helpLabel}</p></div><div className="palmi-guide-step-pill">{index+1}<span>/</span>{steps.length}</div></div>
        <div className="palmi-guide-progress"><div className="palmi-guide-progress-track"><div className="palmi-guide-progress-fill" style={{width:progress+"%"}}/></div></div>
        {isActionStep?<div className="palmi-guide-command"><div className="palmi-command-badge"><Sparkles className="w-3.5 h-3.5"/> TU TURNO</div><div className="palmi-command-title">{step?.actionMessage}</div><div className="palmi-command-status"><span className="palmi-pulse-dot"/> Esperando tu acción…</div></div>:<div className="palmi-guide-body">{index===0&&<div className="palmi-welcome-line">Numa te acompaña. Tú haces el recorrido.</div>}<div className="palmi-guide-message">{step?.message}</div>{step?.tip&&<div className="palmi-guide-tip"><strong>Consejo</strong><span>{step.tip}</span></div>}</div>}
        <div className="palmi-guide-footer"><button type="button" className="palmi-guide-secondary" onClick={close}>Cerrar guía</button><div className="palmi-guide-actions"><button type="button" className="palmi-guide-back" onClick={goPrevious} disabled={index===0} aria-label="Paso anterior"><ChevronLeft size={15}/> Atrás</button>{last?<button type="button" className="palmi-guide-primary" onClick={finish}><CircleCheck className="w-4 h-4"/> Terminar</button>:<button type="button" className={"palmi-guide-primary "+(isActionStep?"is-disabled":"")} onClick={goNext} disabled={isActionStep}>Entendido <ChevronRight className="w-4 h-4"/></button>}</div></div>
      </div>}
      <PWAInstallPrompt visible={showInstallPrompt} onClose={closeInstallPrompt} />
      <div ref={dockRef} className="palmi-guide-mascot-dock" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKeyDown} aria-label="Mover o abrir a Numa" role="button" tabIndex={0}>
        <span className="palmi-aura palmi-aura-1"/><span className="palmi-aura palmi-aura-2"/><span className="palmi-spark palmi-spark-1">✦</span><span className="palmi-spark palmi-spark-2">✦</span><span className="palmi-mascot-stage"><PalmiMascot className="palmi-guide-mascot"/></span><span className="palmi-guide-name">NUMA</span>
      </div>
      {open&&<button type="button" className="palmi-guide-reset" onClick={reset} aria-label="Reiniciar guía" title="Reiniciar guía"><RotateCcw size={13}/></button>}
    </div>
  </div>;
}
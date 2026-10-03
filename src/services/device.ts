import {getSupabase} from "../lib/supabase";
import {getPalmyraScopedStorageKey} from "./localScope";

function getFingerprintKey(){return getPalmyraScopedStorageKey("palmyra-device-fingerprint");}
export function getOrCreateDeviceFingerprint(){
 if(typeof localStorage==="undefined") return "";
 const key=getFingerprintKey(); if(!key)return "";
 const existing=localStorage.getItem(key); if(existing)return existing;
 const value=crypto.randomUUID()+"-"+crypto.randomUUID();
 localStorage.setItem(key,value); return value;
}
export function getDeviceName(){
 if(typeof navigator==="undefined") return "Dispositivo";
 const ua=navigator.userAgent;
 const platform=/Android/i.test(ua)?"Android":/iPhone|iPad|iPod/i.test(ua)?"iOS":/Windows/i.test(ua)?"Windows":/Mac/i.test(ua)?"macOS":/Linux/i.test(ua)?"Linux":"Web";
 const browser=/Edg\//i.test(ua)?"Edge":/Chrome\//i.test(ua)?"Chrome":/Firefox\//i.test(ua)?"Firefox":/Safari\//i.test(ua)?"Safari":"Navegador";
 return browser+" · "+platform;
}
export async function registerCurrentDevice(companyId:string,warehouseId:string){
 const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
 const fingerprint=getOrCreateDeviceFingerprint();
 if(!fingerprint)return;
 const {data,error}=await supabase.rpc("register_current_device",{
  p_company_id:companyId,p_warehouse_id:warehouseId,p_name:getDeviceName(),p_fingerprint:fingerprint
 });
 if(error)throw error;
 return data;
}
import {getSupabase} from "../lib/supabase";

export interface MyDevice {
  id:string;
  name:string;
  fingerprint:string;
  warehouse_id:string|null;
  session_id:string|null;
  last_seen_at:string|null;
  active:boolean;
  is_current:boolean;
}

export async function loadMyDevices(companyId:string){
 const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
 const {data,error}=await supabase.rpc("get_my_devices",{p_company_id:companyId});
 if(error) throw error;
 return (data||[]) as MyDevice[];
}

export async function revokeMyDevice(companyId:string,deviceId:string){
 const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
 const {data,error}=await supabase.rpc("revoke_my_device",{p_device_id:deviceId,p_company_id:companyId});
 if(error) throw error;
 return data;
}

export async function revokeOtherDevices(companyId:string){
 const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
 const {data,error}=await supabase.rpc("revoke_other_devices",{p_company_id:companyId});
 if(error) throw error;
 return data as {ok?:boolean;revoked_count?:number};
}

export async function touchCurrentDevice(companyId:string){
 const supabase=getSupabase(); if(!supabase) return false;
 const {data,error}=await supabase.rpc("touch_current_device",{p_company_id:companyId});
 if(error) throw error;
 return data===true;
}

import {getSupabaseClient} from "./supabase";
import {getActiveStoreId} from "@/services/api/storeContext";
export interface FinancialAuditRow {
 id:string; actorId:string; at:string; before?:number; after?:number; reason?:string;
 request?:{command:string;input?:{reason?:string}};
 result?:{beforePosition?:{purchaseDate:string};afterPosition?:{purchaseDate:string};openingEquityDeltaPiastres?:number};
}
export async function readFinancialAudit(kind:"asset"|"cod",storeId:string,id:string):Promise<FinancialAuditRow[]> {
 const sb=getSupabaseClient();
 if(!sb||await getActiveStoreId()!==storeId)throw Error("تعذّر تحديد متجر سجل التصحيحات.");
 const {data,error}=await sb.rpc(kind==="asset"?"read_asset_audit":"read_cod_fee_audit",
  kind==="asset"?{p_store:storeId,p_asset_id:id}:{p_store:storeId,p_order_id:id});
 if(error||!Array.isArray(data))throw Error("تعذّر قراءة سجل التصحيحات.");
 if(await getActiveStoreId()!==storeId)throw Error("تغيّر المتجر أثناء قراءة سجل التصحيحات.");
 return data;
}

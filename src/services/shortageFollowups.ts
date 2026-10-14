import {getSupabaseClient} from "@/lib/supabase";
import {getSyncIdentity} from "@/services/api/storeContext";
export type ShortageFollowupState = "waiting" | "contacted" | "awaiting_customer" | "procurement";
export interface ShortageFollowup {store_id:string;order_id:string;revision:number;state:ShortageFollowupState;notes:string}
export async function listShortageFollowups(orderIds:readonly string[]):Promise<ShortageFollowup[]> {
  if(!orderIds.length)return [];
  const client=getSupabaseClient(),identity=await getSyncIdentity();
  if(!client||!identity)throw new Error("تعذّر تحديد متجر المتابعة.");
  const {data,error}=await client.from("order_shortage_followups").select("order_id,state,notes,revision,store_id")
    .eq("store_id",identity.storeId).in("order_id",[...new Set(orderIds)]);
  if(error)throw new Error("تعذّر تحديث حالات المتابعة؛ أعد المحاولة.");
  if((await getSyncIdentity())?.storeId!==identity.storeId)throw new Error("تغيّر المتجر أثناء قراءة المتابعة.");
  return data??[];
}
export async function readShortageFollowup(orderId:string,storeId:string):Promise<ShortageFollowup|null> {
  const client=getSupabaseClient();
  if(!client || (await getSyncIdentity())?.storeId!==storeId) throw new Error("تعذّر تحديد متجر المتابعة.");
  const {data,error}=await client.from("order_shortage_followups").select("*").eq("store_id",storeId).eq("order_id",orderId).maybeSingle();
  if(error)throw new Error(error.message);
  if((await getSyncIdentity())?.storeId!==storeId)throw new Error("تغيّر المتجر أثناء قراءة المتابعة.");
  return data;
}
export async function saveShortageFollowup(intent:{id:string;storeId:string;orderId:string;expectedRevision:number;state:ShortageFollowupState;notes:string}) {
  const client=getSupabaseClient();
  if(!client || (await getSyncIdentity())?.storeId!==intent.storeId) throw new Error("ارجع لمتجر المتابعة الأصلي قبل التحقق.");
  const {data,error}=await client.rpc("save_shortage_followup",{p_id:intent.id,p_store:intent.storeId,p_order:intent.orderId,p_expected:intent.expectedRevision,p_state:intent.state,p_notes:intent.notes});
  if(error)throw Object.assign(new Error(error.message),{definite:!!error.code && /^(23|40|42|P0001)/.test(error.code)});
  return data as {followup:ShortageFollowup;replayed:boolean};
}

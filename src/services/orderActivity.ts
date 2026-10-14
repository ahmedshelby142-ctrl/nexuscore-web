import {getSupabaseClient} from "@/lib/supabase";
import {getActiveStoreId} from "@/services/api/storeContext";
export interface OrderActivity {id:string;kind:string;occurred_at:string;label?:string}
/** Cost-free operational history scoped to the active tenant and source order.
 * The server derives saved references; clients never guess or regenerate them. */
export async function readOrderActivity(orderId:string,expectedStoreId?:string):Promise<OrderActivity[]> {
  const client=getSupabaseClient(),storeId=await getActiveStoreId();
  if(!client||!storeId)throw new Error("تعذّر تحديد متجر الطلب.");
  if(expectedStoreId&&storeId!==expectedStoreId)throw new Error("تغيّر المتجر أثناء قراءة السجل.");
  const {data,error}=await client.rpc("read_order_activity",{p_store:storeId,p_order_id:orderId});
  if(error)throw new Error("تعذّر قراءة سجل الطلب؛ أعد المحاولة دون تسجيل أي حركة جديدة.");
  if((await getActiveStoreId())!==storeId)throw new Error("تغيّر المتجر أثناء قراءة السجل.");
  return data??[];
}

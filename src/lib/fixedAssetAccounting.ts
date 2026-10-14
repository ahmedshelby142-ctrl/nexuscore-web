import {getSupabaseClient} from "./supabase";
import {getActiveStoreId} from "@/services/api/storeContext";
import {runFinancialCommand} from "./financialCommand";
import {fromRemoteRow} from "@/services/api/fieldMapping";
import type {RecordResult} from "@/store/useFinancialStore";
export interface AssetAccountingRow {
  id:string; name:string; purchaseDate:string; accountingStartDate:string; deactivatedAt:string|null; paymentSource:string; revision:number;
  grossPiastres:number; residualPiastres:number; accumulatedDepreciationPiastres:number; historicalDepreciationPiastres:number;
  netBookPiastres:number; remainingDepreciablePiastres:number; monthlyEstimatePiastres:number; periodDepreciationPiastres:number;
  usefulLifeMonths:number; usefulLifeEndsOn:string; remainingLifeMonths:number; status:string; reviewReason:string|null;
}
export interface AssetAccounting {
  storeId:string; asOf:string; policy:string; rows:AssetAccountingRow[]; reviewRequired:boolean;
  grossCostPiastres:number; accumulatedDepreciationPiastres:number; historicalDepreciationPiastres:number;
  netBookPiastres:number; periodDepreciationPiastres:number; lifetimeDepreciationPiastres:number;
  openingEquityAdjustmentPiastres:number; monthlyEstimatePiastres:number;
  capitalPurchasesReclassifiedPiastres:number; capitalPurchasesReclassifiedLifetimePiastres:number;
}
export interface AccountingPosition {
 storeId:string;wallet:number;stock:number;reservedStock:number;customerNet:number;courierReceivable:number;courierPayable:number;
 supplierPayable:number;customerDeposits:number;fixedAssets:number;totalAssets:number;liabilities:number;netAssets:number;
 equity:number;openingEquity:number;accumulatedProfit:number;reconciliationDifference:number;reviewRequired:boolean;assetAccounting:AssetAccounting;
}
export async function readAccountingPosition():Promise<AccountingPosition> {
 const sb=getSupabaseClient(),store=await getActiveStoreId();
 if(!sb||!store)throw new Error("تعذّر تحديد متجر المركز المالي.");
 const {data,error}=await sb.rpc("accounting_position",{p_store:store});
 if(error||!data)throw new Error("تعذّر قراءة المركز المالي.");
 if(await getActiveStoreId()!==store||data.storeId!==store)throw new Error("تغيّر المتجر أثناء قراءة المركز المالي.");
 return data as AccountingPosition;
}
/** The database owns calendar/rounding and capitalization. A failed read is not zero. */
export async function readFixedAssetAccounting(window?:{from?:Date;to?:Date}):Promise<AssetAccounting> {
  const sb=getSupabaseClient(),store=await getActiveStoreId();
  if(!sb||!store)throw new Error("تعذّر تحديد متجر محاسبة الأصول.");
  const {data,error}=await sb.rpc("fixed_asset_accounting",{p_store:store,p_asof:null,p_from:window?.from?.toISOString()??null,p_to:window?.to?.toISOString()??null});
  if(error||!data)throw new Error("تعذّر قراءة محاسبة الأصول الثابتة.");
  if(await getActiveStoreId()!==store||data.storeId!==store)throw new Error("تغيّر المتجر أثناء قراءة الأصول.");
  if(data.reviewRequired)throw new Error("تحتاج بيانات أصل قديم أو قيده إلى مراجعة؛ لا يمكن تأكيد صافي الأصول والربح.");
  return data as AssetAccounting;
}

/** Canonical asset id comes from the durable financial-command envelope. */
export async function commitFixedAsset(asset:{name:string;purchaseValue:number;salvageValue:number;usefulLifeYears:number;purchaseDate:string;paymentSource:string}):Promise<RecordResult<any>&{resolved?:boolean}> {
 let committed:{asset:any;replayed:boolean}|undefined;
 try {
  const storeId=await getActiveStoreId();if(!storeId)throw Error("تعذّر تحديد متجر الأصل.");
  const result=await runFinancialCommand<{asset:any;replayed:boolean}>("asset_record",{asset},"asset_record",storeId);
  committed=result;
  if(await getActiveStoreId()!==storeId)throw Object.assign(Error("تم تسجيل الأصل في متجره الأصلي؛ تغيّر المتجر أثناء التأكيد. راجع السجل."),{resolved:true,definite:true});
  const row=fromRemoteRow("fixed_assets",result.asset);
  const {useFinancialStore}=await import("@/store/useFinancialStore");
  useFinancialStore.setState(s=>{const current=s.assets.find(a=>a.id===row.id);
   return current&&Number(current.updated_at)>Number(row.updated_at??0)?{}:{assets:[...s.assets.filter(a=>a.id!==row.id),row]};});
  window.dispatchEvent(new CustomEvent("ledger-sync-pulled"));
  return {success:true,row,replayed:result.replayed===true};
 }catch(e:any){
  // A UI/cache refresh failure after confirmation must never invite another
  // acquisition with a fresh id. The document and wallet already committed.
  if(committed&&!e.resolved)return {success:true,row:committed.asset,replayed:committed.replayed===true};
  return {success:false,reason:e instanceof Error?e.message:String(e),definite:e.definite===true,resolved:e.resolved===true};
 }
}

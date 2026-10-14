import Decimal from "decimal.js";
import {codState,COD_STATE_LABELS_AR} from "./shippingRates.ts";
import {fulfillmentSummary} from "./orderFulfillment.ts";
import type {EcommerceOrder} from "@/types";

/** Presentation only: customer outstanding is the persisted document, never a
 * fresh subtraction of credit/deposits already allocated by PostgreSQL. */
export function orderManagementSummary(order:Partial<EcommerceOrder>) {
  const monetary=(value:unknown)=>{try{const n=new Decimal((value??0) as Decimal.Value);return n.isFinite()?n:null;}catch{return null;}};
  const goods=monetary(order.totalAmount),shipping=monetary(order.shippingFee),trip=monetary(order.wastedTripCompensation);
  const total=goods&&shipping&&trip?goods.plus(shipping).plus(trip).toDecimalPlaces(2).toNumber():null;
  const state=codState(order as EcommerceOrder);
  const outstanding=state==="due"||state==="with_courier"?monetary(order.expectedCod)?.toNumber()??null:0;
  const allocation=fulfillmentSummary(order.fulfillment);
  const badges:string[]=[];
  if(order.isExchange)badges.push("استبدال");
  if(allocation&&!allocation.ready)badges.push(allocation.valid?`نواقص ${allocation.missing}`:"مراجعة الحجز");
  if(order.exchangeDetails?.credit?.status==="refund_due")badges.push("رصيد مستحق للعميل");
  if(order.status==="returned"&&!order.returnConfirmedAt)badges.push("ينتظر استلام المرتجع");
  if(order.return_cause==="courier")badges.push("متابعة الشحن");
  if(state==="with_courier")badges.push("تحصيل عند المندوب");
  return {total,outstanding,codLabel:COD_STATE_LABELS_AR[state],badges,
    quantity:(order.items??[]).reduce((n,i)=>n+Math.max(0,Number(i.quantity)||0),0),
    products:(order.items??[]).map(i=>`${i.bundleName||i.productName}${i.variantName?` — ${i.variantName}`:""} × ${i.quantity}`).join("، ")};
}

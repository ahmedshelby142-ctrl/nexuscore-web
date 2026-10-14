import type {AssetAccounting} from "@/lib/fixedAssetAccounting";
import {formatMoney} from "@/lib/math";
import {Button} from "@/components/ui/button";
import {Table,TableHeader,TableHead,TableRow,TableBody,TableCell} from "@/components/ui/table";
import {OpeningAssetDateEditor} from "./OpeningAssetDateEditor";
import {FinancialCorrectionHistory} from "./FinancialCorrectionHistory";
const status:Record<string,string>={active:"نشط",inactive:"متوقف الإهلاك",fully_depreciated:"مستهلك بالكامل",not_recognized:"قبل تاريخ الاعتراف"};
const wallet:Record<string,string>={prepaid:"تم الدفع مسبقًا (موجود بالفعل)",inStoreSafe:"خزينة المحل",instaPay:"انستا باي",vodafoneCash:"فودافون كاش",bankAccount:"حساب بنكي"};
export function FixedAssetRegister({data,loading,error,onDeactivate,canCorrectOpening=false,onCorrected}:{data:AssetAccounting|null;loading:boolean;error:string|null;onDeactivate:(id:string)=>void;canCorrectOpening?:boolean;onCorrected?:()=>void}) {
 if(error)return <p role="alert">{error}</p>;
 if(loading||!data)return <p role="status">جارٍ قراءة القيمة الدفترية للأصول…</p>;
 return <div className="space-y-4">
  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
   <div><dt>إجمالي تكلفة الأصول</dt><dd>{formatMoney(data.grossCostPiastres/100)}</dd></div>
   <div><dt>مجمع الإهلاك</dt><dd>{formatMoney(data.accumulatedDepreciationPiastres/100)}</dd></div>
   <div><dt>صافي قيمة الأصول الثابتة</dt><dd>{formatMoney(data.netBookPiastres/100)}</dd></div>
  </dl>
  <Table><TableHeader><TableRow><TableHead>الأصل / التواريخ</TableHead><TableHead>قيمة الشراء / المتبقي</TableHead>
   <TableHead>العمر الافتراضي</TableHead><TableHead>مجمع الإهلاك</TableHead><TableHead>القيمة الدفترية الحالية</TableHead>
   <TableHead>الإهلاك الشهري التقديري</TableHead><TableHead>الدفع / الحالة</TableHead><TableHead>إجراءات</TableHead>
  </TableRow></TableHeader><TableBody>
   {data.rows.map(a=><TableRow key={a.id}>
    <TableCell><strong>{a.name}</strong><p>الشراء / الخدمة: {a.purchaseDate}</p><p>بدء المحاسبة: {a.accountingStartDate}</p></TableCell>
    <TableCell>{formatMoney(a.grossPiastres/100)}<p>قيمة التخريد: {formatMoney(a.residualPiastres/100)}</p><p>باقي قابل للإهلاك: {formatMoney(a.remainingDepreciablePiastres/100)}</p></TableCell>
    <TableCell>{a.usefulLifeMonths/12} سنة<p>العمر المتبقي بالأشهر الكاملة: {a.remainingLifeMonths}</p><p>نهاية العمر: {a.usefulLifeEndsOn}</p></TableCell>
    <TableCell>{formatMoney(a.accumulatedDepreciationPiastres/100)}<p>قبل بدء المحاسبة: {formatMoney(a.historicalDepreciationPiastres/100)}</p></TableCell>
    <TableCell>{formatMoney(a.netBookPiastres/100)}</TableCell>
    <TableCell>{formatMoney(a.monthlyEstimatePiastres/100)}</TableCell>
    <TableCell>{wallet[a.paymentSource]??a.paymentSource}<p>{status[a.status]??a.status}</p>{a.deactivatedAt&&<p>توقف: {a.deactivatedAt}</p>}</TableCell>
    <TableCell><div className="flex flex-col gap-2"><Button variant="outline" size="sm" disabled={a.status!=="active"} onClick={()=>onDeactivate(a.id)}>إيقاف إهلاك الأصل {a.name}</Button>
     {canCorrectOpening&&a.status==="active"&&a.paymentSource==="prepaid"&&<OpeningAssetDateEditor asset={a} storeId={data.storeId} onSaved={onCorrected}/>}
     <FinancialCorrectionHistory kind="asset" storeId={data.storeId} id={a.id}/></div></TableCell>
   </TableRow>)}
   {!data.rows.length&&<TableRow><TableCell colSpan={8}>لا توجد أصول ثابتة مسجلة.</TableCell></TableRow>}
  </TableBody></Table>
  <p className="text-xs text-muted-foreground">الإهلاك محسوب حتى {data.asOf} بأشهر تقويمية من تاريخ الخدمة وتوزيع يومي للجزء من الشهر، مع تقريب المجموع التراكمي بالقرش. الإهلاك السابق للاعتراف ضمن الرصيد الافتتاحي ولا يدخل أرباح الفترة الجديدة. الأصل المدفوع مسبقًا لا يخصم نقدية؛ شراء الأصل من المحفظة يُرسمل ولا يُحمّل بالكامل على التشغيل. إيقاف الإهلاك يحفظ القيمة والتاريخ؛ ليس حذفًا أو قيد بيع للأصل.</p>
 </div>;
}

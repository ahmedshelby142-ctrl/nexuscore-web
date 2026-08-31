import { formatMoney } from "@/lib/math";

interface OrderDetail {
  orderNumber: string;
  expectedCod: number;
  fee: number;
}

export interface CourierSettlementReportProps {
  settlement: {
    id: string;
    courierName: string;
    at: Date;
    codTotal: number;
    expectedFees: number;
    expectedNet: number;
    netReceived: number;
    shortfall: number;
  };
  orders: OrderDetail[];
}

export function CourierSettlementReport({ settlement, orders }: CourierSettlementReportProps) {
  return (
    <div id="courier-settlement-print-root" className="hidden print:block print:bg-white print:p-8 print:w-full font-sans text-black" dir="rtl">
      {/* Header */}
      <div className="flex justify-between items-start border-b-2 border-black pb-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">كشف تسوية حساب شحن</h1>
          <p className="text-lg">شركة الشحن: <strong>{settlement.courierName}</strong></p>
        </div>
        <div className="text-left text-sm space-y-1">
          <p>التاريخ: <span className="font-mono">{settlement.at.toLocaleDateString("ar-EG")}</span></p>
          <p>الوقت: <span className="font-mono">{settlement.at.toLocaleTimeString("ar-EG")}</span></p>
          <p>رقم التسوية: <span className="font-mono">{settlement.id.slice(0, 8).toUpperCase()}</span></p>
        </div>
      </div>

      {/* Orders Table */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4">الطلبات المسلّمة في هذه الدفعة</h2>
        <table className="w-full border-collapse border border-gray-400">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-4 py-2 text-right">رقم الطلب</th>
              <th className="border border-gray-400 px-4 py-2 text-center">التحصيل (COD)</th>
              <th className="border border-gray-400 px-4 py-2 text-center">العمولة/الشحن</th>
              <th className="border border-gray-400 px-4 py-2 text-center">الصافي للطلب</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order, i) => (
              <tr key={i}>
                <td className="border border-gray-400 px-4 py-2 font-mono">{order.orderNumber}</td>
                <td className="border border-gray-400 px-4 py-2 text-center font-mono">
                  {formatMoney(order.expectedCod)}
                </td>
                <td className="border border-gray-400 px-4 py-2 text-center font-mono">
                  {formatMoney(order.fee)}
                </td>
                <td className="border border-gray-400 px-4 py-2 text-center font-mono font-medium">
                  {formatMoney(order.expectedCod - order.fee)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Financial Summary */}
      <div className="flex justify-end">
        <div className="w-1/2 rounded-xl border-2 border-gray-800 p-6 space-y-4">
          <h2 className="text-xl font-bold border-b border-gray-300 pb-2">ملخص الحساب</h2>
          
          <div className="flex justify-between text-lg">
            <span>إجمالي التحصيل:</span>
            <span className="font-mono">{formatMoney(settlement.codTotal)}</span>
          </div>
          
          <div className="flex justify-between text-lg text-gray-700">
            <span>عمولات ومصاريف الشحن:</span>
            <span className="font-mono">{formatMoney(settlement.expectedFees)}</span>
          </div>
          
          <div className="flex justify-between text-lg font-bold border-t border-gray-300 pt-2">
            <span>الصافي المستحق:</span>
            <span className="font-mono">{formatMoney(settlement.expectedNet)}</span>
          </div>
          
          <div className="flex justify-between text-lg mt-4">
            <span>المبلغ المحول فعلياً:</span>
            <span className="font-mono">{formatMoney(settlement.netReceived)}</span>
          </div>

          <div className={`flex justify-between text-xl font-bold border-t-2 border-gray-800 pt-4 ${settlement.shortfall > 0 ? 'text-red-700' : 'text-green-700'}`}>
            <span>الفارق / العجز:</span>
            <span className="font-mono">
              {settlement.shortfall > 0 
                ? formatMoney(Math.abs(settlement.shortfall)) + " (عجز مطلوب سداده)"
                : settlement.shortfall === 0 
                  ? "تمت التسوية بالكامل" 
                  : formatMoney(Math.abs(settlement.shortfall)) + " (زيادة)"}
            </span>
          </div>
        </div>
      </div>

      {/* Footer / Signatures */}
      <div className="mt-20 flex justify-between px-10 text-center">
        <div>
          <p className="font-bold mb-8">توقيع المستلم (المتجر)</p>
          <p className="border-t border-black w-48 pt-2">.....................</p>
        </div>
        <div>
          <p className="font-bold mb-8">توقيع المندوب / شركة الشحن</p>
          <p className="border-t border-black w-48 pt-2">.....................</p>
        </div>
      </div>
      
      {/* Hide Print UI for actual printing */}
      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          body * {
            visibility: hidden;
          }
          #courier-settlement-print-root, #courier-settlement-print-root * {
            visibility: visible;
          }
          #courier-settlement-print-root {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
        }
      `}} />
    </div>
  );
}

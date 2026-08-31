import { useState, useMemo } from "react";
import { formatMoney } from "@/lib/math";
import { Truck, Package } from "lucide-react";
import { useFinancialStore } from "@/store/useFinancialStore";
import type { ShippingInfo } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const STATUS_LABELS: Record<string, string> = {
  pending: "قيد التجهيز",
  processing: "قيد التجهيز",
  shipped: "تم الشحن",
  delivered: "تم التوصيل",
  returned_partial: "مرتجع جزئي",
  returned_full: "مرتجع كامل",
};

const STATUS_OPTIONS = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  "returned_partial",
  "returned_full",
] as const;

export interface ShippingSelectorProps {
  value: ShippingInfo;
  onChange: (info: ShippingInfo) => void;
  /** Persona label override (e.g. "لوجستيات النقل والشحن الدولي" for factory/corporate) */
  personaLabel?: string;
}

export function ShippingSelector({ value, onChange, personaLabel }: ShippingSelectorProps) {
  const allTariffs = useFinancialStore((s) => s.shippingTariffs);
  const shippingTariffs = useMemo(() => allTariffs.filter((t) => t.isActive), [allTariffs]);
  const [selectedTariffId, setSelectedTariffId] = useState(value.tariffId || "");

  const selectedTariff = useMemo(
    () => shippingTariffs.find((t) => t.id === selectedTariffId),
    [shippingTariffs, selectedTariffId],
  );

  const handleToggle = (requires: boolean) => {
    onChange({
      requiresShipping: requires,
      tariffId: undefined,
      destination: undefined,
      customerCharge: 0,
      actualCost: 0,
      courierName: undefined,
      trackingId: undefined,
      status: undefined,
    });
    if (!requires) setSelectedTariffId("");
  };

  const handleTariffChange = (tariffId: string) => {
    setSelectedTariffId(tariffId);
    const tariff = shippingTariffs.find((t) => t.id === tariffId);
    if (tariff) {
      onChange({
        ...value,
        requiresShipping: true,
        tariffId: tariff.id,
        destination: tariff.destination,
        customerCharge: tariff.customerCharge,
        actualCost: tariff.actualCost,
        status: "pending",
      });
    }
  };

  return (
    <div className="rounded-xl border border-border p-4 space-y-4 bg-muted/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="size-4 text-muted-foreground" />
          <Label className="text-sm font-medium cursor-pointer">
            {personaLabel || "يتطلب شحن؟"}
          </Label>
        </div>
        <Switch checked={value.requiresShipping} onCheckedChange={handleToggle} />
      </div>

      {value.requiresShipping && (
        <div className="space-y-4 pr-6 border-r-2 border-primary/20">
          <div className="space-y-1.5">
            <Label>جهة الشحن</Label>
            <Select value={selectedTariffId} onValueChange={handleTariffChange}>
              <SelectTrigger>
                <SelectValue placeholder="اختر وجهة الشحن..." />
              </SelectTrigger>
              <SelectContent>
                {shippingTariffs.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.destination} — {formatMoney(t.customerCharge)} ({t.deliveryDays} يوم)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedTariff && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-2 rounded-lg bg-green-50 border border-green-200">
                <p className="text-xs text-green-700">التكلفة على العميل</p>
                <p className="font-bold text-green-800">
                  {formatMoney(selectedTariff.customerCharge)}
                </p>
              </div>
              <div className="p-2 rounded-lg bg-orange-50 border border-orange-200">
                <p className="text-xs text-orange-700">التكلفة الفعلية</p>
                <p className="font-bold text-orange-800">
                  {formatMoney(selectedTariff.actualCost)}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>اسم شركة الشحن / المندوب</Label>
              <Input
                placeholder="مثال: أرامكس / أحمد"
                value={value.courierName || ""}
                onChange={(e) => onChange({ ...value, courierName: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>رقم تتبع الشحنة (Tracking ID)</Label>
              <Input
                placeholder="مثال: SHIP-001"
                value={value.trackingId || ""}
                onChange={(e) => onChange({ ...value, trackingId: e.target.value })}
              />
            </div>
          </div>

          {/* Shipping status badges for retail/online */}
          {value.status && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">حالة الشحن:</span>
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange({ ...value, status: s })}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    value.status === s
                      ? "bg-primary/10 border-primary text-primary"
                      : "bg-transparent border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

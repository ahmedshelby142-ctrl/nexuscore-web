/**
 * Pick a registered courier. Never type one.
 *
 * ## Why a select and not an input
 *
 * The courier on an order is not a label — it is the counterparty whose money
 * the ledger books against. `receivable_courier` and `payable_courier` are
 * keyed by `courierId`, and `courierIdOf` falls back to the literal `"default"`
 * when an order has none. So an order that named «أرامكس» in a free-text box
 * had its COD booked to a courier called `default`, and حسابات الشحن showed the
 * balance under a name nobody recognised.
 *
 * Registration lives in حسابات الشحن (`/courier-ledger`), which is ADMIN-only,
 * and the RLS policy on `couriers` matches that exactly — so "add a company
 * only in the management screen" is enforced, not just hidden.
 *
 * ## Old records still render
 *
 * `legacyName` is the `courierName` an existing order already carries. An order
 * written before the registry existed has a name and no id, and must still show
 * that name rather than an empty box — so it is offered as a disabled-looking
 * extra row and stays selected until someone picks a real courier.
 */

import { useMemo } from "react";
import { useCourierStore } from "@/store/useCourierStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The sentinel for "this order predates the registry". */
export const LEGACY_COURIER = "__legacy__";

export interface CourierSelectProps {
  /** The registry id currently on the order. */
  value: string;
  /** Called with the id AND the name, so the order can snapshot both. */
  onChange: (courierId: string, courierName: string) => void;
  /** A `courierName` from before the registry, if this order has one. */
  legacyName?: string;
  id?: string;
  disabled?: boolean;
}

export function CourierSelect({
  value,
  onChange,
  legacyName,
  id,
  disabled,
}: CourierSelectProps) {
  const accounts = useCourierStore((s) => s.accounts);

  const couriers = useMemo(
    () =>
      (accounts ?? [])
        .filter((c: any) => !c.deleted_at)
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "ar")),
    [accounts],
  );

  // A name with no id: keep showing it rather than silently blanking the field.
  const showLegacy = Boolean(legacyName) && !value;

  return (
    <Select
      value={showLegacy ? LEGACY_COURIER : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === LEGACY_COURIER) return;
        const picked = couriers.find((c: any) => c.id === next);
        onChange(next, picked ? String(picked.name) : "");
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="اختر شركة الشحن…" />
      </SelectTrigger>
      <SelectContent>
        {showLegacy && (
          <SelectItem value={LEGACY_COURIER}>{legacyName} (قديم — غير مسجَّل)</SelectItem>
        )}
        {couriers.length === 0 && !showLegacy && (
          <SelectItem value="__none__" disabled>
            مفيش شركات شحن متسجّلة — سجّلها من حسابات الشحن
          </SelectItem>
        )}
        {couriers.map((c: any) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
            {c.phone ? ` — ${c.phone}` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

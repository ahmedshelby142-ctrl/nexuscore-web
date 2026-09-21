/**
 * Names for the ids the ledger settles against.
 *
 * ## The problem this fixes
 *
 * `owner_financial_summary` returns balances keyed by SUBJECT ID, because that
 * is what the ledger is keyed by — `payable_supplier` by supplier id,
 * `receivable_courier` by `courierId`. The Owner screen rendered those ids
 * straight, so «مستحقات الموردين» read
 * `26dfe561-69ac-4d82-9d0b-25fe3053d89b — ٢٬٣٣٠٫٠٠ ج.م.`
 *
 * The persona architecture asks this screen for "عليك ١٢٬٤٠٠ ج.م للموردين" —
 * a fact the owner can act on. A UUID is not one. You cannot ring it.
 *
 * ## No second lookup
 *
 * Both readers here already exist and are already the canonical ones:
 * `readSuppliers` is what the توريد picker uses, and `readMobileCouriers` is
 * what الشحنات uses to turn an order's `courierId` into the registry's name.
 * This hook only holds their answers in a Map so a list can ask repeatedly.
 *
 * ## An unresolved id stays visible
 *
 * `undefined` means "this id is not in the registry", and the caller renders a
 * deliberate «غير معروف» plus the raw id. It must never become a blank, a
 * zero, or a plausible-looking name: an orphaned balance is real money the
 * owner still has to chase, and the id is the only handle left on it.
 *
 * Live data has three of these — `courierId = "default"` (the legacy bucket,
 * which `readMobileCouriers` documents as not a registry entity), a
 * `cert-courier` and a `qa-supplier` with no supplier row at all.
 */

import { useEffect, useState } from "react";
import { readSuppliers } from "@/lib/receiving";
import { readMobileCouriers } from "./mobileReaders";

export interface SubjectNames {
  /** Supplier id → company name. */
  suppliers: ReadonlyMap<string, string>;
  /** Courier id → registry name. */
  couriers: ReadonlyMap<string, string>;
}

const EMPTY: SubjectNames = { suppliers: new Map(), couriers: new Map() };

/**
 * Read both registries once.
 *
 * Failure is deliberately silent: a name is a nicety, and a balance the owner
 * needs to see must not be withheld because the label lookup failed. The ids
 * still render through the caller's fallback, so nothing is hidden.
 *
 * ponytail: `readSuppliers` pages, and this asks for its 200-row maximum — the
 * same ceiling the توريد picker accepts. A shop past 200 suppliers would see
 * the overflow fall back to «غير معروف» rather than go missing; resolve by id
 * if that ever becomes real.
 */
export function useSubjectNames(enabled: boolean): SubjectNames {
  const [names, setNames] = useState<SubjectNames>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      const [suppliers, couriers] = await Promise.all([
        readSuppliers({ limit: 200 }).catch(() => []),
        readMobileCouriers().catch(() => new Map()),
      ]);
      if (cancelled) return;
      setNames({
        suppliers: new Map(
          suppliers
            .filter((supplier) => supplier.id && supplier.companyName)
            .map((supplier) => [String(supplier.id), String(supplier.companyName)]),
        ),
        couriers: new Map(
          [...couriers.values()]
            .filter((courier) => courier.id && courier.name)
            .map((courier) => [String(courier.id), String(courier.name)]),
        ),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return names;
}

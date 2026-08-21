/**
 * Removing a customer — asked first, and asked the right question.
 *
 * Same rule as the product screen and the partners screen, one entity over.
 * Ask the ledger before deciding:
 *
 *   - no `customer_ltv` line and no order → REAL delete. The row was typed by
 *     mistake or belongs to someone who never bought anything; nothing points
 *     at it, so nothing breaks when it goes.
 *   - any history → ARCHIVE. They leave every picker, search and suggestion,
 *     and a future order from that number opens a fresh record rather than
 *     quietly reviving this one — while their orders and their LTV stay
 *     exactly as recorded, and قاعدة العملاء can still name them.
 *
 * The test is the ROW COUNT, never the sum. A customer who bought 300 and
 * returned all of it sums to exactly zero LTV and still has a full history;
 * `balances()` returns a row whenever lines exist, so counting rows is the
 * honest question and reading the total is the trap.
 *
 * Nothing here touches the ledger: archiving is a tombstone on reference data.
 */

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ledgerRowsFor } from "@/lib/ledger";
import { customerRemovalMode, orderBelongsTo } from "@/lib/customers";
import { useCustomerStore } from "@/store/useCustomerStore";
import { useOrderStore } from "@/store/useOrderStore";
import type { CustomerProfile } from "@/types";

interface CustomerRemovalDialogProps {
  customer: CustomerProfile | null;
  onClose: () => void;
  onRemoved?: () => void;
}

type Mode = "loading" | "delete" | "archive" | "error";

export function CustomerRemovalDialog({
  customer,
  onClose,
  onRemoved,
}: CustomerRemovalDialogProps) {
  const { removeCustomer, archiveCustomer } = useCustomerStore();
  const orders = useOrderStore((s) => s.orders);
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [orderCount, setOrderCount] = useState(0);

  useEffect(() => {
    if (!customer) return;
    let cancelled = false;
    setMode("loading");
    setError(null);

    void (async () => {
      try {
        const rows = await ledgerRowsFor(customer.id, ["customer_ltv"]);
        // Orders count even before delivery: a pending order names this
        // customer, and deleting them would orphan it.
        const placed = orders.filter((o) => orderBelongsTo(o, customer)).length;
        if (cancelled) return;
        setOrderCount(placed);
        setMode(customerRemovalMode(rows, placed));
      } catch (e) {
        if (cancelled) return;
        // Unknown never falls through to "delete it".
        setError(e instanceof Error ? e.message : String(e));
        setMode("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [customer, orders]);

  function confirm() {
    if (!customer) return;
    if (mode === "archive") archiveCustomer(customer.id);
    else if (mode === "delete") removeCustomer(customer.id);
    else return;
    onRemoved?.();
    onClose();
  }

  const title =
    mode === "archive"
      ? "العميل ده ليه سجل — هيتأرشف مش هيتمسح"
      : "متأكد إنك عايزة تمسحي العميل ده؟";

  const description = !customer
    ? ""
    : mode === "loading"
      ? "بنراجع طلباته ومشترياته في الدفتر…"
      : mode === "error"
        ? `مقدرناش نراجع السجل، فمعملناش أي حاجة. جرّبي تاني. (${error})`
        : mode === "archive"
          ? `${customer.name} ليه ${orderCount > 0 ? `${orderCount} طلب متسجل` : "مشتريات متسجلة في الدفتر"}. هيتشال من قايمة العملاء ومن البحث، ولو جالك طلب تاني من نفس الرقم هيتفتح له كارت جديد. كل طلباته وإجمالي مشترياته القديمة هتفضل زي ما هي في التقارير.`
          : `${customer.name} لسه مفيش عليه أي طلبات ولا مشتريات — هيتمسح نهائي. مش هينفع ترجعيه.`;

  return (
    <AlertDialog open={customer !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>إلغاء</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              if (mode === "loading" || mode === "error") {
                e.preventDefault();
                return;
              }
              confirm();
            }}
            disabled={mode === "loading" || mode === "error"}
          >
            {mode === "archive" ? "تأكيد الأرشفة" : "تأكيد المسح"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

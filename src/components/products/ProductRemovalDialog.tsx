/**
 * Deleting a product, asked first — and only when it is safe to delete.
 *
 * The reported bug: the trash icon deleted instantly, so one misclick wiped a
 * product. Worse than the missing confirmation was what the confirmation would
 * have been confirming: the ledger is append-only, and hard-deleting a product
 * it has already recorded leaves sale/purchase/opening-balance lines pointing
 * at nothing, which is how a report starts showing blanks it cannot explain.
 *
 * So the dialog asks the ledger first and says which of the two things it is
 * about to do, in the user's words: مسح نهائي for a product the ledger has
 * never mentioned, أرشفة for one it has.
 *
 * Both delete buttons in the app (المنتجات and المخازن) render this — the
 * decision lives here once rather than twice.
 */

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { ledgerRowsFor } from "@/lib/ledger";
import { removalMode } from "@/lib/product";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { Product } from "@/types";

interface ProductRemovalDialogProps {
  /** The product awaiting confirmation, or null when the dialog is closed. */
  product: Product | null;
  onClose: () => void;
  /** Called after the record actually changed, so lists can re-read. */
  onRemoved?: () => void;
}

type Mode = "loading" | "delete" | "archive" | "error";

export function ProductRemovalDialog({ product, onClose, onRemoved }: ProductRemovalDialogProps) {
  const { removeProduct, archiveProduct } = useBusinessStore();
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    setMode("loading");
    setError(null);

    void (async () => {
      try {
        // Rows, not a balance: see `removalMode`.
        const rows = await ledgerRowsFor(product.id);
        if (cancelled) return;
        setMode(removalMode(rows));
      } catch (e) {
        if (cancelled) return;
        // A failed read must NOT fall through to "no history, delete it".
        // Unknown means we do not touch the product at all.
        setError(e instanceof Error ? e.message : String(e));
        setMode("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [product]);

  function confirm() {
    if (!product) return;
    if (mode === "archive") archiveProduct(product.id);
    else if (mode === "delete") removeProduct(product.id);
    else return;
    onRemoved?.();
    onClose();
  }

  const title =
    mode === "archive"
      ? "المنتج ده ليه حركات مسجلة — هيتأرشف مش هيتمسح"
      : "متأكد إنك عايز تمسح المنتج ده؟";

  const description = !product
    ? ""
    : mode === "loading"
      ? "بنراجع حركات المنتج في الدفتر…"
      : mode === "error"
        ? `مقدرناش نراجع حركات المنتج، فمعملناش أي حاجة. جرّب تاني. (${error})`
        : mode === "archive"
          ? `"${product.name}" اتباع أو اتورّد أو ليه رصيد افتتاحي، والدفتر مبيتمسحش منه حاجة. هيتشال من قوائم المنتجات والبيع، وكل حركاته وتقاريره تفضل زي ما هي. تقدر ترجّعه بعدين.`
          : `"${product.name}" لسه مفيش عليه أي حركة في الدفتر — لا بيع ولا توريد ولا رصيد افتتاحي — فهيتمسح نهائي. مش هينفع ترجعه.`;

  return (
    <AlertDialog open={product !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>إلغاء</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // The dialog closes itself on action; keep it open while the
              // ledger check is still running or has failed.
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

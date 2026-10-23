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

import { useEffect, useRef, useState } from "react";
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
import { readProductArchiveStatus, productSaveError } from "@/lib/productArchive";
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
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    setMode("loading");
    setError(null);

    void (async () => {
      try {
        // Authoritative history plus live commitments, not a net stock balance.
        const state = await readProductArchiveStatus(product.id);
        if (cancelled) return;
        if (!state.canArchive) {
          setError(
            state.bundleDependencies > 0
              ? productSaveError(new Error("NEXUS_PRODUCT_USED_IN_ACTIVE_BUNDLE"))
              : productSaveError(new Error("NEXUS_PRODUCT_HAS_PENDING_COMMITMENTS")),
          );
          setMode("error");
          return;
        }
        setMode(state.canDelete ? "delete" : "archive");
      } catch (e) {
        if (cancelled) return;
        // A failed read must NOT fall through to "no history, delete it".
        // Unknown means we do not touch the product at all.
        setError(productSaveError(e));
        setMode("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [product]);

  async function confirm() {
    if (!product || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      if (mode === "archive") await archiveProduct(product.id);
      else if (mode === "delete") await removeProduct(product.id);
      else return;
      onRemoved?.();
      onClose();
    } catch (e) {
      setError(productSaveError(e));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const title =
    mode === "archive" ? "للمنتج سجل محفوظ — هيتأرشف مش هيتمسح" : "متأكد إنك عايز تمسح المنتج ده؟";

  const description = !product
    ? ""
    : mode === "loading"
      ? "بنراجع حركات المنتج في الدفتر…"
      : mode === "error"
        ? (error ?? "تعذّر التحقق من حالة المنتج؛ لم يبدأ التعديل.")
        : mode === "archive"
          ? `"${product.name}" اتباع أو اتورّد أو ليه رصيد افتتاحي، والدفتر مبيتمسحش منه حاجة. هيتشال من قوائم المنتجات والبيع، وكل حركاته وتقاريره تفضل زي ما هي. تقدر ترجّعه بعدين.`
          : `"${product.name}" لسه مفيش عليه أي حركة في الدفتر — لا بيع ولا توريد ولا رصيد افتتاحي — فهيتمسح نهائي. مش هينفع ترجعه.`;

  return (
    <AlertDialog open={product !== null} onOpenChange={(open) => !open && !saving && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {error && mode !== "error" && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving} onClick={onClose}>
            إلغاء
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // The dialog closes itself on action; keep it open while the
              // ledger check is still running or has failed.
              e.preventDefault();
              if (mode !== "loading" && mode !== "error" && !saving) void confirm();
            }}
            disabled={mode === "loading" || mode === "error" || saving}
          >
            {saving ? "جارٍ تأكيد الحفظ…" : mode === "archive" ? "تأكيد الأرشفة" : "تأكيد المسح"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

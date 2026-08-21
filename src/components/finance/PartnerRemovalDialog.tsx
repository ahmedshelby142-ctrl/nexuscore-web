/**
 * Removing a شريك or مساهم — asked first, and asked the right question.
 *
 * The original complaint, from early in the project: "can't delete a partner,
 * it just stays inactive forever". Worse than the stuck state was what stayed
 * behind it — an inactive partner's capital was still counted in
 * إجمالي رأس المال, and it was not clear whether their percentage still ate
 * into the 100%.
 *
 * Same rule as the product screen, one entity over. Ask the ledger first:
 *   - no history at all  → REAL delete. The record goes, the percentage is
 *     immediately available again, the capital stops counting.
 *   - any history        → ARCHIVE. They leave the active list, stop counting
 *     toward the cap and toward رأس المال (they are no longer a claim on
 *     future profit), and every past draw and distribution stays exactly as it
 *     was recorded.
 *
 * Nothing here touches the ledger: archiving is a tombstone on reference data.
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
import { partnerRemovalMode, countDistributionsFor } from "@/lib/partners";
import { useBusinessStore } from "@/store/useBusinessStore";
import { PARTNER_KIND_LABELS } from "@/types";
import type { Partner } from "@/types";

interface PartnerRemovalDialogProps {
  partner: Partner | null;
  onClose: () => void;
  onRemoved?: () => void;
}

type Mode = "loading" | "delete" | "archive" | "error";

export function PartnerRemovalDialog({ partner, onClose, onRemoved }: PartnerRemovalDialogProps) {
  const { removePartner, archivePartner, partnerLedger } = useBusinessStore();
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [distributions, setDistributions] = useState(0);

  useEffect(() => {
    if (!partner) return;
    let cancelled = false;
    setMode("loading");
    setError(null);

    void (async () => {
      try {
        // Draws are `owner_budget` lines keyed to the partner; distributions
        // are recorded documents. Either one is history worth keeping.
        const rows = await ledgerRowsFor(partner.id, ["owner_budget"]);
        const paid = countDistributionsFor(partnerLedger, partner.id);
        if (cancelled) return;
        setDistributions(paid);
        setMode(partnerRemovalMode(rows, paid));
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
  }, [partner, partnerLedger]);

  function confirm() {
    if (!partner) return;
    if (mode === "archive") archivePartner(partner.id);
    else if (mode === "delete") removePartner(partner.id);
    else return;
    onRemoved?.();
    onClose();
  }

  const who = partner ? `${partner.name} (${PARTNER_KIND_LABELS[partner.kind]})` : "";

  const title =
    mode === "archive"
      ? "الشخص ده ليه سجل — هيتأرشف مش هيتمسح"
      : "متأكد إنك عايز تمسح الشخص ده؟";

  const description = !partner
    ? ""
    : mode === "loading"
      ? "بنراجع سجل المسحوبات والتوزيعات…"
      : mode === "error"
        ? `مقدرناش نراجع السجل، فمعملناش أي حاجة. جرّب تاني. (${error})`
        : mode === "archive"
          ? `${who} ليه ${distributions > 0 ? `${distributions} توزيع أرباح متسجل` : "مسحوبات متسجلة"}. هيتشال من قايمة الشركاء، ونسبته (${partner.equityPercentage}%) هتترجع متاحة لحد تاني، ورأس ماله مش هيتحسب في إجمالي رأس المال. كل مسحوباته وتوزيعاته القديمة هتفضل زي ما هي في التقارير.`
          : `${who} لسه مفيش عليه أي مسحوبات ولا توزيعات — هيتمسح نهائي، ونسبته (${partner.equityPercentage}%) هتبقى متاحة على طول. مش هينفع ترجعه.`;

  return (
    <AlertDialog open={partner !== null} onOpenChange={(open) => !open && onClose()}>
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

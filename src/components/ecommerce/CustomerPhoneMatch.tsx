/**
 * Search-first customer entry, keyed on the phone number.
 *
 * The order form used to take a name and a phone as free text and let the
 * store work out afterwards whether that person already existed. It worked out
 * wrong — «01012345678» and «+20 101 234 5678» opened two records — and the
 * owner never saw the decision being made. This panel makes it visible and
 * makes her the one who takes it.
 *
 * The two rules it holds, from §3.7:
 *
 *   - **Never auto-select.** Even a single exact match is shown and waits for
 *     «ده هو». An order carries money onto a customer record for the rest of
 *     that customer's life; the app does not get to guess which one.
 *   - **Show enough to tell two people apart.** Name, full number and last
 *     order date, because «أحمد» matching «أحمد» tells her nothing.
 *
 * Matching lives in `@/lib/customers` — pure, and tested without React.
 */

import { useMemo } from "react";
import { Check, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activeCustomers, resolveByPhone } from "@/lib/customers";
import type { ArchivableCustomer, MatchableCustomer } from "@/lib/customers";
import { formatMoney } from "@/lib/math";

interface CustomerPhoneMatchProps {
  customers: (MatchableCustomer & ArchivableCustomer)[];
  /** Whatever is currently typed in the phone field. */
  phone: string;
  /** The customer already linked to this order, if she has picked one. */
  linkedId: string;
  onPick: (customer: MatchableCustomer) => void;
  onUnlink: () => void;
  /** `SUM(customer_ltv)` per id, so she can tell two «أحمد»s apart by spend. */
  ltvOf?: (customerId: string) => number;
}

export function CustomerPhoneMatch({
  customers,
  phone,
  linkedId,
  onPick,
  onUnlink,
  ltvOf,
}: CustomerPhoneMatchProps) {
  const match = useMemo(() => resolveByPhone(customers, phone), [customers, phone]);
  // Looked up among the ACTIVE customers only, so archiving someone while a
  // draft order sits open drops the chip and asks her to pick again — rather
  // than showing "linked to X" while the save quietly opens a new record,
  // which is what `upsertTarget` does with an archived id.
  const linked = linkedId ? activeCustomers(customers).find((c) => c.id === linkedId) : undefined;

  // ── Already linked: say so, and offer the way out ──
  if (linked) {
    return (
      <div className="rounded-xl border border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-900 p-3 flex items-center gap-3 flex-wrap">
        <Check className="size-4 text-green-700 dark:text-green-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-green-900 dark:text-green-200">
            الطلب هيتسجّل على العميل: {linked.name}
          </p>
          <p className="text-xs text-green-800 dark:text-green-300 mt-0.5">
            {linked.phone}
            {ltvOf ? ` — إجمالي مشترياته: ${formatMoney(ltvOf(linked.id))}` : ""}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onUnlink}>
          <X className="size-3.5 ml-1.5" />
          إلغاء الربط
        </Button>
      </div>
    );
  }

  // ── Nothing typed yet, or too few digits to guess from ──
  if (match.kind === "none") {
    // Only claim "new customer" once there is a real number to claim it about.
    // Saying it against an empty field would train her to ignore the line.
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 4) return null;
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-3 flex items-center gap-3">
        <UserPlus className="size-4 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground">
          الرقم ده مش مسجَّل عندنا — هيتعمل كارت عميل جديد أول ما تحفظي الطلب.
        </p>
      </div>
    );
  }

  const found = match.kind === "one" ? [match.customer] : match.customers;

  return (
    <div className="rounded-xl border border-blue-300 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-blue-700 dark:text-blue-400 shrink-0" />
        <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
          {match.kind === "one"
            ? "العميل ده يمكن يكون مسجَّل عندنا"
            : `فيه ${found.length} عملاء بأرقام قريبة — اختاري الصح`}
        </p>
      </div>
      {/* Never pre-selected, not even when there is exactly one. */}
      <ul className="space-y-2">
        {found.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-3 flex-wrap rounded-lg bg-background border border-border/60 px-3 py-2"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                {c.phone}
                {c.lastOrderAt ? ` — آخر طلب: ${formatDate(c.lastOrderAt)}` : " — لسه مافيش طلبات"}
                {ltvOf ? ` — ${formatMoney(ltvOf(c.id))}` : ""}
              </p>
            </div>
            <Button type="button" size="sm" onClick={() => onPick(c)}>
              ده هو
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-blue-900 dark:text-blue-300">
        مش أي واحد منهم؟ كمّلي عادي — هيتعمل كارت عميل جديد.
      </p>
    </div>
  );
}

function formatDate(at: Date | string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("ar-EG");
}

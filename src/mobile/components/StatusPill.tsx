/**
 * StatusPill — renders a canonical domain status with taxonomy-driven styling.
 *
 * Screens MUST NOT pass className or colour choices directly.
 * They pass a `tone` from the taxonomy and this component owns the visual output.
 *
 * Usage:
 * ```tsx
 * const entry = resolveOrderStatus(order.status);
 * <StatusPill labelAr={entry.labelAr} tone={entry.tone} />
 * ```
 */

import type { StatusTone } from "@/mobile/viewmodels/types";

export interface StatusPillProps {
  /** Arabic label for the status. Must come from the taxonomy, not invented. */
  labelAr: string;
  /** Semantic tone key from the status taxonomy. */
  tone: StatusTone;
  /** Optional additional class for layout positioning only (not colour). */
  className?: string;
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "mobile-status-pill--neutral",
  info: "mobile-status-pill--info",
  success: "mobile-status-pill--success",
  warning: "mobile-status-pill--warning",
  critical: "mobile-status-pill--critical",
  muted: "mobile-status-pill--muted",
};

export function StatusPill({ labelAr, tone, className }: StatusPillProps) {
  return (
    <span
      className={`mobile-status-pill ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`}
      aria-label={labelAr}
    >
      {labelAr}
    </span>
  );
}

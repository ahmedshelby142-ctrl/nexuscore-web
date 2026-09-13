/**
 * MobileAppBar — top application bar for mobile screens.
 *
 * Replaces the current plain `<header>` in MobileShell with a reusable,
 * semantically correct component. Phase B screens will use this directly.
 *
 * Requirements: RTL, safe-area aware, 44px+ tap targets, accessible.
 */

import type { ReactNode } from "react";

export interface MobileAppBarProps {
  /** Primary title shown in the bar. Arabic. */
  title: string;
  /** Optional sub-label above the title (eyebrow text). */
  eyebrow?: string;
  /** Optional action slot — rendered on the inline-start side in RTL. */
  leadingAction?: ReactNode;
  /** Optional action slot — rendered on the inline-end side in RTL. */
  trailingAction?: ReactNode;
  /** Accessible label for the nav landmark. Defaults to the title. */
  ariaLabel?: string;
}

export function MobileAppBar({
  title,
  eyebrow,
  leadingAction,
  trailingAction,
  ariaLabel,
}: MobileAppBarProps) {
  return (
    <header
      className="mobile-app-bar"
      role="banner"
      aria-label={ariaLabel ?? title}
    >
      {leadingAction && (
        <div className="mobile-app-bar-leading">{leadingAction}</div>
      )}
      <div className="mobile-app-bar-title">
        {eyebrow && <p className="mobile-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
      </div>
      {trailingAction && (
        <div className="mobile-app-bar-trailing">{trailingAction}</div>
      )}
    </header>
  );
}

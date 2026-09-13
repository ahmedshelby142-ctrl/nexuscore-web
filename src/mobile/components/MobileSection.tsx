/**
 * MobileSection — a labelled content section for mobile screens.
 *
 * Provides consistent heading hierarchy and spacing for screen sections
 * (e.g. "التنبيهات", "الطلبات الأخيرة"). Always uses an appropriate heading
 * level, never a plain div with bold text.
 */

import type { ReactNode } from "react";

export interface MobileSectionProps {
  /** Arabic section heading. */
  titleAr: string;
  /** Optional trailing action (e.g. "عرض الكل" link). */
  action?: ReactNode;
  children: ReactNode;
  /** Semantic heading level. Defaults to h2. */
  headingLevel?: 2 | 3 | 4;
}

export function MobileSection({
  titleAr,
  action,
  children,
  headingLevel = 2,
}: MobileSectionProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  return (
    <section className="mobile-section" aria-labelledby={undefined}>
      <div className="mobile-section-header">
        <Heading className="mobile-section-title">{titleAr}</Heading>
        {action && <div className="mobile-section-action">{action}</div>}
      </div>
      <div className="mobile-section-body">{children}</div>
    </section>
  );
}

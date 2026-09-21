import { SessionIdentity } from "@/components/layout/SessionIdentity";

/**
 * The dashboard header used by the TanStack file-route in `src/routes/index.tsx`.
 *
 * ## Read this before changing it
 *
 * **Nothing serves this today.** `src/main.tsx` renders `App` (react-router);
 * `src/router.tsx`, `routeTree.gen.ts` and everything under `src/routes/*.tsx`
 * that declares `createFileRoute` are a second, unmounted router stack. The
 * shipped chrome is `components/layout/Layout.tsx`.
 *
 * It is kept correct rather than left to rot because it was not harmless. It
 * held the two literals `"سارة المصري"` and `"مدير النظام"`, so the day anyone
 * mounted this router — or copied this file, which is how it got here — the
 * product would have shown a fictional admin to every signed-in user. Dead code
 * that would ship a lie is one route change away from shipping it.
 *
 * ## What was removed, and why none of it was a feature
 *
 * Three more controls here did nothing at all:
 *
 * - A search input with no `value`, no `onChange` and no handler.
 * - A notification bell with no `onClick` and an unread dot rendered
 *   unconditionally — a permanent badge for a system that does not exist.
 * - A قطاعي/جملة toggle backed by `useState` that nothing else read.
 *
 * Each is a focusable, labelled control that answers a press with nothing,
 * which is worse than its absence: it teaches the operator the feature is
 * broken rather than absent. They are deleted rather than wired up, because
 * global search and notifications are features (see `docs/DESKTOP_PRODUCT_AUDIT.md`
 * §C-57, §C-67), not omissions to patch in a header.
 */
export function Header() {
  return (
    <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="flex items-center gap-4 px-8 py-4">
        <div>
          <p className="text-xs tracking-widest text-muted-foreground">لوحة التحكم</p>
          <h2 className="font-display text-2xl font-bold">نظرة عامة</h2>
        </div>

        <div className="mr-auto flex items-center gap-4">
          <SessionIdentity />
        </div>
      </div>
    </header>
  );
}

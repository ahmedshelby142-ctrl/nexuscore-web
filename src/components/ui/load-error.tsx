import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "We could not read this" — with a way to ask again.
 *
 * The banner نظرة عامة already used, lifted out unchanged so every screen
 * that can fail says so the same way. Not a new visual: same border, same
 * tint, same outline button.
 *
 * ## One retry at a time
 *
 * A retry button that is clicked twice must not ask twice. The click is
 * refused while `busy` (the reads it re-runs are still in flight) and for a
 * short moment after each click — the ref, not state, so two clicks inside one
 * frame cannot both get through before a re-render disables the button.
 *
 * `onRetry` must call the screen's EXISTING reader — a hook's `refresh`, the
 * hydrate for that table. This component never fetches anything itself.
 */

const DEFAULT_MESSAGE = "تعذّر تحميل البيانات. تحقّق من الاتصال وجرّب تاني.";

/** How long a click locks the button, when the caller cannot report `busy`. */
const CLICK_LOCK_MS = 1000;

export function LoadError({
  message = DEFAULT_MESSAGE,
  detail,
  onRetry,
  busy = false,
  className,
}: {
  message?: string;
  /** The technical reason, shown in parentheses for whoever reports it. */
  detail?: string | null;
  onRetry: () => void;
  busy?: boolean;
  className?: string;
}) {
  const locked = useRef(false);
  const [, setLockTick] = useState(0);

  const retry = () => {
    if (busy || locked.current) return;
    locked.current = true;
    setLockTick((t) => t + 1);
    onRetry();
    setTimeout(() => {
      locked.current = false;
      setLockTick((t) => t + 1);
    }, CLICK_LOCK_MS);
  };

  return (
    <div
      role="alert"
      className={cn(
        "rounded-xl border border-destructive/40 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <p className="text-sm text-destructive">
        {message}
        {detail ? ` (${detail})` : ""}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={retry}
        disabled={busy || locked.current}
      >
        إعادة المحاولة
      </Button>
    </div>
  );
}

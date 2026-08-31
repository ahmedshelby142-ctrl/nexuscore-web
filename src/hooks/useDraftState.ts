/**
 * Form state that survives leaving the screen.
 *
 * ## The problem it solves
 *
 * Every form on every screen held its fields in plain `useState`. React Router
 * unmounts a route's element when you navigate away, and React discards the
 * state with it. So: fill in half an order, check a price on another screen,
 * come back — empty form, start again. Nothing was "resetting" or "re-seeding"
 * the form; there was simply never anywhere for a half-finished form to live.
 *
 * ## Why sessionStorage
 *
 * A draft should outlive a navigation and an accidental reload, and should
 * *not* outlive the working session — coming in tomorrow to yesterday's
 * half-typed customer still sitting in the form is its own bug, and worse,
 * because the stock and prices behind it have moved on. `sessionStorage` has
 * exactly that lifetime, for free, with no store to wire and nothing to clear
 * on logout. Drafts are not business records; they never go near the ledger or
 * the sync queue.
 *
 * ## Using it
 *
 * Drop-in for `useState` — same tuple, same setter (value or updater fn):
 *
 *     const [name, setName] = useDraftState("eco-order:name", "");
 *
 * Call `clearDrafts(prefix)` after a successful save, so a submitted form
 * doesn't come back from the dead on the next visit.
 */

import { useState, useEffect, useCallback, useRef } from "react";

/** One namespace for everything this module owns, so `clearDrafts` can't reach outside it. */
const PREFIX = "nexuscore:draft:";

/**
 * Storage access that cannot take a screen down.
 *
 * sessionStorage throws in a few real situations — Safari private browsing,
 * a disabled-storage policy, quota exhaustion. A form losing its draft is a
 * papercut; a form throwing on every keystroke is a broken screen. So every
 * access degrades to plain in-memory `useState` behaviour.
 */
function readDraft<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeDraft<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* Draft persistence is a convenience; never let it break typing. */
  }
}

/**
 * `useState`, but the value is restored when the component remounts.
 *
 * `initial` is read once on first mount, exactly like `useState`'s initial
 * value — changing it later does not clobber a draft the user is typing into.
 */
export function useDraftState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readDraft(key, initial));

  // The key identifies the draft. If a screen ever swaps it (editing order A,
  // then order B), load that draft instead of leaving B showing A's data.
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setValue(readDraft(key, initial));
    }
    // `initial` is deliberately not a dependency: it is often a fresh object
    // literal, and depending on it would reset the form on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    writeDraft(key, value);
  }, [key, value]);

  return [value, setValue];
}

/**
 * Drop every draft whose key starts with `prefix` — call it after a save
 * succeeds, so the next visit starts clean instead of re-offering an order
 * that is already in the ledger.
 */
export function clearDrafts(prefix: string): void {
  try {
    const full = PREFIX + prefix;
    // Collect first: removing while iterating `key(i)` skips entries.
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(full)) doomed.push(k);
    }
    for (const k of doomed) sessionStorage.removeItem(k);
  } catch {
    /* Nothing to clear if storage is unavailable. */
  }
}

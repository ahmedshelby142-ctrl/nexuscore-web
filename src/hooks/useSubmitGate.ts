import { useRef } from "react";

/**
 * Lets one async submit run at a time.
 *
 * `if (saving) return; setSaving(true)` does NOT do this, which is what every
 * submit handler in this app relied on. React state updates are asynchronous:
 * two clicks in the same tick both read `saving === false`, both pass the
 * guard, and both fire the write. Proven live on شاشة المشتريات — three
 * presses of "حفظ الفاتورة" produced three POSTs to `ledger_events`, i.e.
 * three purchases, three stock receipts and three debits of the till.
 *
 * It is also, almost certainly, what put the duplicate FM-0001 purchase in
 * this database: two `supplier_invoice` events for one receipt, three seconds
 * apart.
 *
 * A ref flips synchronously, so the second caller sees it. `saving` state is
 * still what disables the button and renders the spinner — this only closes
 * the window before React re-renders.
 */
export function useSubmitGate() {
  const busy = useRef(false);
  return {
    /** True if this call owns the submit; false if one is already running. */
    enter: () => (busy.current ? false : (busy.current = true)),
    exit: () => {
      busy.current = false;
    },
  };
}

/**
 * Run an async handler at most once at a time, whatever way it returns.
 *
 * `useSubmitGate` needs an `enter()` and a matching `exit()` on every path, and
 * these handlers have many: a validation `return`, a `catch` that returns, and
 * the success tail. Miss one and the button is dead for the rest of the
 * session — a worse bug than the one being fixed.
 *
 * This takes the whole body instead, so the release is in a `finally` and no
 * path can skip it:
 *
 *     const confirmDeliver = async () => runOnce(async () => { …body… });
 *
 * Re-entry is dropped, not queued. A second click during an in-flight write is
 * a mistake, not an instruction to do it twice.
 */
export function useRunOnce() {
  const busy = useRef(false);
  return async function runOnce<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await fn();
    } finally {
      busy.current = false;
    }
  };
}

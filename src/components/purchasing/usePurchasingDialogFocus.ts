import { useRef } from "react";

/** Controlled Purchasing dialogs have ordinary buttons outside Dialog.Root. */
export function usePurchasingDialogFocus(fallbackId = "purchasing-heading") {
  const trigger = useRef<HTMLElement | null>(null);
  return {
    remember(element: HTMLElement | null) {
      trigger.current = element;
    },
    restore(event: Event) {
      const destination =
        trigger.current?.isConnected && !trigger.current.matches(":disabled")
          ? trigger.current
          : document.getElementById(fallbackId);
      if (destination) {
        event.preventDefault();
        destination.focus();
      }
    },
  };
}

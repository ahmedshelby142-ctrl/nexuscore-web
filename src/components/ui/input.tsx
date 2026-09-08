import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, inputMode, ...props }, ref) => {
    return (
      <input
        type={type}
        /**
         * Money and quantity fields should open a numeric keypad.
         *
         * There are 51 `type="number"` inputs in this app — prices, quantities,
         * discounts, expense amounts — and four of them set `inputMode`. On
         * Android `type="number"` alone commonly opens a keypad with no decimal
         * separator, which is the wrong keyboard for a price. Defaulting it here
         * fixes every one of them without editing 51 call sites, and any input
         * that needs `numeric` (integers only) or `text` can still pass its own.
         */
        inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";
import { X } from "lucide-react";

/** The existing bottom sheet, with modal keyboard and trigger focus behavior. */
export function MobileFilterDialog({
  open,
  onOpenChange,
  trigger,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="mobile-sheet-backdrop">
          <Dialog.Content className="mobile-more-sheet" aria-describedby={undefined}>
            <div className="mobile-sheet-title-row">
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="mobile-icon-button" aria-label="إغلاق">
                  <X aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

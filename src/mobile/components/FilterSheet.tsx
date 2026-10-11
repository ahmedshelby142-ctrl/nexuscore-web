import { Check, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { MobileFilterDialog } from "./MobileFilterDialog";

export interface MobileFilterOption {
  id: string;
  label: string;
}

export function FilterSheet({
  label = "تصفية",
  options,
  value,
  onChange,
}: {
  label?: string;
  options: readonly MobileFilterOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MobileFilterDialog
      open={open}
      onOpenChange={setOpen}
      title={label}
      trigger={
        <button type="button" className="mobile-filter-trigger" aria-haspopup="dialog">
          <SlidersHorizontal aria-hidden="true" />{" "}
          {options.find((option) => option.id === value)?.label ?? label}
        </button>
      }
    >
      <div className="mobile-filter-options">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="mobile-filter-option"
            onClick={() => {
              onChange(option.id);
              setOpen(false);
            }}
          >
            <span>{option.label}</span>
            {value === option.id && <Check aria-hidden="true" />}
          </button>
        ))}
      </div>
    </MobileFilterDialog>
  );
}

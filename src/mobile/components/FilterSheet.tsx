import { Check, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";

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
    <>
      <button type="button" className="mobile-filter-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <SlidersHorizontal aria-hidden="true" /> {options.find((option) => option.id === value)?.label ?? label}
      </button>
      {open && (
        <div className="mobile-sheet-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mobile-sheet-title-row"><h2 id="mobile-filter-title">{label}</h2><button type="button" className="mobile-icon-button" onClick={() => setOpen(false)} aria-label="إغلاق"><X aria-hidden="true" /></button></div>
            <div className="mobile-filter-options">
              {options.map((option) => <button key={option.id} type="button" className="mobile-filter-option" onClick={() => { onChange(option.id); setOpen(false); }}><span>{option.label}</span>{value === option.id && <Check aria-hidden="true" />}</button>)}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
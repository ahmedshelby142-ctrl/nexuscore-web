import { CalendarDays, Check, X } from "lucide-react";
import { useState } from "react";
import {
  ORDER_DATE_PRESETS,
  orderDateFilterLabel,
  resolveOrderDateFilter,
  type OrderDateSelection,
} from "@/mobile/viewmodels/orderDateFilter";

/**
 * «التاريخ» on Orders: the presets, or «فترة مخصصة» with من/إلى.
 *
 * A custom range is applied only by «تطبيق», and only when it is complete and
 * in order — one date alone or a reversed pair never reaches the query. Native
 * date inputs, as on Desktop's Orders page: the platform's own picker.
 */
export function OrderDateFilter({
  value,
  onChange,
}: {
  value: OrderDateSelection;
  onChange: (value: OrderDateSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OrderDateSelection>(value);
  const resolution = resolveOrderDateFilter(draft);
  const close = () => setOpen(false);
  const pick = (selection: OrderDateSelection) => { onChange(selection); close(); };

  return (
    <>
      <button
        type="button"
        className={`mobile-filter-trigger${value.preset !== "all" ? " is-active" : ""}`}
        onClick={() => { setDraft(value); setOpen(true); }}
        aria-haspopup="dialog"
      >
        <CalendarDays aria-hidden="true" /> {orderDateFilterLabel(value)}
      </button>
      {open && (
        <div className="mobile-sheet-backdrop" role="presentation" onMouseDown={close}>
          <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-date-filter-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mobile-sheet-title-row">
              <h2 id="mobile-date-filter-title">التاريخ</h2>
              <button type="button" className="mobile-icon-button" onClick={close} aria-label="إغلاق"><X aria-hidden="true" /></button>
            </div>
            <div className="mobile-filter-options">
              {ORDER_DATE_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="mobile-filter-option"
                  aria-pressed={draft.preset === option.id}
                  onClick={() => (option.id === "custom" ? setDraft({ preset: "custom", from: draft.from, to: draft.to }) : pick({ preset: option.id }))}
                >
                  <span>{option.label}</span>
                  {draft.preset === option.id && <Check aria-hidden="true" />}
                </button>
              ))}
            </div>
            {draft.preset === "custom" && (
              <div className="mobile-form mobile-date-range">
                <label htmlFor="mobile-orders-from">من تاريخ</label>
                <input id="mobile-orders-from" type="date" dir="ltr" value={draft.from ?? ""} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                <label htmlFor="mobile-orders-to">إلى تاريخ</label>
                <input id="mobile-orders-to" type="date" dir="ltr" value={draft.to ?? ""} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
                {(resolution.status === "reversed" || resolution.status === "invalid") && (
                  <p className="mobile-form-error" role="alert">{resolution.messageAr}</p>
                )}
                <button type="button" className="mobile-primary-button" disabled={resolution.status !== "ok"} onClick={() => pick(draft)}>
                  تطبيق
                </button>
              </div>
            )}
            {value.preset !== "all" && (
              <button type="button" className="mobile-text-button" onClick={() => pick({ preset: "all" })}>مسح التاريخ</button>
            )}
          </section>
        </div>
      )}
    </>
  );
}

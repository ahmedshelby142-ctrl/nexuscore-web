import { Search, X } from "lucide-react";

export function MobileSearch({
  value,
  onChange,
  placeholder,
  onClear,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onClear?: () => void;
}) {
  return (
    <label className="mobile-search">
      <Search aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button type="button" onClick={onClear ?? (() => onChange(""))} aria-label="مسح البحث"><X aria-hidden="true" /></button>}
    </label>
  );
}
/**
 * The one order-search field, used by every screen that finds an order before
 * acting on it: order management (cancel / edit / confirm a return), returns
 * and exchanges.
 *
 * One text box, three targets — order number, customer name, phone — matched
 * together by `matchesOrderQuery`. There is deliberately no mode picker and no
 * search button: the user types and the list narrows. Making someone declare
 * "I am about to type a phone number" before typing it is work the app can do
 * itself.
 */

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface OrderSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** How many orders the query currently matches. */
  resultCount: number;
  /** How many there are in total, before the query. */
  totalCount: number;
  placeholder?: string;
}

export function OrderSearch({
  value,
  onChange,
  resultCount,
  totalCount,
  placeholder,
}: OrderSearchProps) {
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "ابحث برقم الأوردر أو اسم العميل أو رقم التليفون..."}
          className="pr-9 pl-9 h-10"
        />
        {value && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-1 top-1/2 -translate-y-1/2 size-7"
            onClick={() => onChange("")}
            aria-label="مسح البحث"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Says what the list is showing, so a filtered view is never mistaken
          for "there are only three orders". */}
      <p className="text-xs text-muted-foreground">
        {value.trim()
          ? resultCount === 0
            ? "مفيش أوردر مطابق — جرّب رقم أقصر أو جزء من الاسم"
            : `${resultCount} من ${totalCount} أوردر`
          : `${totalCount} أوردر`}
      </p>
    </div>
  );
}

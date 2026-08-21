import { Construction } from "lucide-react";

export function PlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-12 text-center space-y-4">
      <Construction className="size-10 mx-auto text-muted-foreground/50" />
      <div>
        <h3 className="text-xl font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {description || "هذه الوحدة قيد التطوير — ستكون متاحة قريباً"}
        </p>
      </div>
    </div>
  );
}

import { Construction } from "lucide-react";

/**
 * The screen for a module that does not exist yet.
 *
 * `description` used to be an ALTERNATIVE to the "قيد التطوير" line
 * (`{description || "…"}`), and every route passes one — so the sentence saying
 * the module is unbuilt never rendered on any of the eight placeholder routes.
 * What the owner saw was a titled, empty, permanently-blank screen that read as
 * a broken feature rather than an absent one. The two lines say different
 * things, so both are shown: the notice always, the description when given.
 */
export function PlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-12 text-center space-y-4">
      <Construction className="size-10 mx-auto text-muted-foreground/50" />
      <div>
        <h3 className="text-xl font-semibold">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
        <p className="text-sm font-medium text-amber-600 dark:text-amber-500 mt-3">
          هذه الوحدة قيد التطوير — ستكون متاحة قريباً
        </p>
      </div>
    </div>
  );
}

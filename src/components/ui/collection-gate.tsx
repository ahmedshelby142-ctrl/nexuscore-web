import type { ReactNode } from "react";
import { useCallback } from "react";
import { useSyncStatus } from "@/store/useSyncStatus";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import type { ReadState } from "@/lib/figure";

/**
 * Where a screen's cloud tables stand: loading, failed, or ready.
 *
 * The stores these screens list from start EMPTY and are filled by the
 * hydrate, so `rows.length === 0` means three different things — nothing
 * exists, nothing has arrived yet, or the read failed — and every list used to
 * answer all three with its empty message. This reads the per-table status the
 * hydrate records and says which it is.
 *
 * Failure outranks loading, for the same reason `statusOf` gives: a table that
 * failed is not "on its way".
 *
 * `retry` re-reads ONLY the failed tables, through `hydrateTable` — the same
 * reader and the same store the boot hydrate used, without emptying anything
 * else. Already-in-flight tables are skipped inside `hydrateTable`.
 */
export function useCollectionStatus(tables: string[]) {
  // The two maps, not a derived array: a selector that builds a new array on
  // every call never compares equal and re-renders forever.
  const statuses = useSyncStatus((s) => s.tables);
  const errors = useSyncStatus((s) => s.tableErrors);

  const failed = tables.filter((t) => statuses[t] === "failed");
  // An absent entry has not been asked for yet — the boot hydrate is waiting
  // on the session. That is loading, never "empty".
  const loading = tables.some((t) => statuses[t] !== "ready");

  const status: "loading" | "error" | "ready" =
    failed.length > 0 ? "error" : loading ? "loading" : "ready";

  const tablesKey = tables.join(",");
  const retry = useCallback(() => {
    void import("@/services/cloudHydrate").then(({ hydrateTable }) => {
      for (const table of tablesKey.split(",")) {
        if (useSyncStatus.getState().tables[table] === "failed") {
          // The failure is recorded in the status store; nothing to do here.
          hydrateTable(table).catch(() => {});
        }
      }
    });
  }, [tablesKey]);

  const error = failed.length > 0 ? (errors[failed[0]] ?? "read failed") : null;
  return {
    status,
    error,
    retry,
    /** The same answer in the shape `moneyFigure` / `figureOr` take. */
    read: { loading: status === "loading", error } as ReadState,
  };
}

/**
 * Render `children` only once every listed table has actually been read.
 *
 * Wraps a LIST REGION — the table and its empty message together — so that the
 * existing «لا توجد …» only ever appears when the read succeeded and returned
 * nothing. Loading shows skeleton rows, failure shows `LoadError` with a retry.
 */
export function CollectionGate({
  tables,
  children,
  rows = 4,
  message,
}: {
  tables: string[];
  children: ReactNode;
  /** Skeleton rows while loading. */
  rows?: number;
  message?: string;
}) {
  const { status, error, retry } = useCollectionStatus(tables);

  if (status === "error") {
    return <LoadError message={message} detail={error} onRetry={retry} />;
  }
  if (status === "loading") {
    return (
      <div className="space-y-2 p-4" aria-busy="true" aria-label="جاري التحميل">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Read every row of a PostgREST query, not the first 1000.
 *
 * PostgREST caps a response at 1000 rows and says so in no way the caller can
 * see: a truncated page is a successful response with fewer rows in it, exactly
 * like a table that really is that short. Two places in this app were bitten by
 * that, so the loop lives here once:
 *
 *   * `ledger/driver.ts` — a balance is a SUM over every line ever written for
 *     an account, and a shop with history crosses 1000. A short read there is
 *     stock that vanished.
 *   * `services/cloudData.ts` — `cloudList` read a whole table in one select,
 *     so a shop past 1000 orders saw its first 1000 and nothing said the rest
 *     existed.
 *
 * ponytail: pages client-side. Correct at any size, but it transfers every row.
 * If a read ever gets slow, the upgrade is a Postgres view or RPC that returns
 * the aggregate — this function is the only thing that would change.
 */

export const PAGE = 1000;

/**
 * `build(from, to)` runs one request for an inclusive row range. Called until
 * a page comes back short, which is the only signal that the end was reached.
 */
export async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

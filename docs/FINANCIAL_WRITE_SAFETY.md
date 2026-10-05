# Financial write safety foundation

The forward-only migration `supabase/migrations/20261005115027_financial_write_safety.sql`
adds `ledger_events.command_request` and `command_result`, extends `ledger_append`
to insert them atomically, and adds `record_financial_command`. It does not update
or delete historical records. The existing event primary key is the command identity;
there is no separate deduplication table or overlapping operation ID.

## Retry contract

`src/lib/financialCommand.ts` retains one request and event UUID per unresolved
command scope in sessionStorage. This is retry metadata, not an offline balance
or write queue. An uncertain response is retried once automatically. Later retries,
including after a reload in that tab, submit the same identity and original payload.
Same-draft concurrent calls share a promise. A changed draft resolves the earlier
uncertain request and asks the operator to review it before making a new entry.
Non-finite numbers are rejected before JSON serialization. Pending requests mark
the page unsafe for automatic PWA reload. A definite initial SQL rejection permits
correction; a SQL rejection following an uncertain attempt retains the identity.

The server checks existing role/store authorization and serializes a command ID
with a transaction advisory lock. Matching immutable request metadata returns the
saved result with `replayed: true`. A changed payload returns
`NEXUS_OPERATION_PAYLOAD_MISMATCH`. A failure before commit leaves no command,
document, supplier, allocation, counter increment, or ledger effect to compensate.
Retry receipts last as long as immutable ledger history. Session retry metadata
lasts for that browser tab's session; clearing browser storage loses that metadata.

## Authoritative transactions

- **Ledger only:** owner draw, capital, contribution and stock/wallet openings keep
  their existing builders and line semantics. The server converts EGP to integer
  piastres and invokes the existing semantic validator. Product creation checks
  unresolved opening commands before creating another product on a retry.
- **Receipt:** supplier lookup or explicitly requested creation, document number,
  invoice, stock quantity/value, wallet payment, payable and ledger lines commit
  together. Both Desktop purchasing and Mobile/Desktop Quick Restock call this
  path. Client compensation deletion is removed. Product stock mirroring remains
  optional and cannot turn a committed receipt into a reported financial failure.
  Replays refresh current invoice documents rather than overwriting them with a
  saved result that predates subsequent payments or returns.
- **Supplier settlement:** the server locks the supplier and outstanding invoices,
  allocates oldest due first, updates paid/remaining/status, and appends wallet and
  payable reductions in the same transaction. Partial, multiple-invoice and excess
  prepayment behavior remains supported. Client invoice lists are previews only.

Both functions are SECURITY INVOKER with a pinned search path. Existing RLS,
immutable ledger policies and the same-transaction ledger line policy remain in
force. The command permits ADMIN/ACCOUNTANT as before; owner capital/contribution
require ADMIN. MODERATOR and foreign-store requests are denied. No role grants are
broadened; the new RPC has no PUBLIC/anon execution grant. Ledger text timestamps
retain JavaScript ISO format for existing lexicographic date filters.

## Bounded historical census, 2026-10-05

The census found no new material unexplained monetary corruption. It checked
parentless/mismatched lines, zero-line headers, repeated references, missing receipt
invoices, purchase balance structures, and supplier payment allocations.

Ordinary stores had 175 events: LUNA BEAUTY 21 and store
`c1c919f9-1d0e-469e-a33e-6a1acb3196e2` 154; four other stores had none.
The QA store had 174. Preserved ordinary legacy headers:

- FM-0001 zero-line events `9a077734-3b69-4d86-b6e2-0a30f9fc779c` and
  `7a29038c-353d-495c-8a48-0243e74e0e64`; the later valid event and invoice remain.
- Zero-effect stock-opening headers `b873f125-4481-4a62-9443-b775700aa568`,
  `afa4ff99-06fd-44f0-bf00-0a8f0f878804`, and
  `fd5b57d6-2b17-4389-b5cc-cde4cba6793c`.

Preserved QA anomalies include `M21-FORCED-FAIL`/FM-FORCED, `qa-short-ev`,
and zero-line FM0006 event `382e5914-154e-4722-a644-4f806046b33c`.
The QA FM0004 remaining balance is explained by returns. Repeated supplier-return
references identify suppliers, not duplicate operation IDs. Ordinary supplier
allocation totals were explainable by payments, returns and permitted prepayment.
No historical reconciliation, synthetic lines or timestamp/reference edits occur.

Before rollout, all 349 event rows and 766 line rows were fingerprinted at
`2026-10-05 02:12:22.909464+00`: event hash
`942e89772fc7a44a87b6317f40bc109f`, line hash
`187ff683646361519be90a10203e27d7`. The event fingerprint excludes only the two
new nullable metadata columns, allowing direct before/after preservation checks.

## Durable validation

`scripts/check_financial_safety.mjs` runs the repository migration and actual
existing semantic validator against disposable local PostgreSQL, using separate
connections for concurrency and authenticated RLS fixture roles. The fixture
models the affected schema and policies; it is not a complete Supabase deployment.
It covers replay/mismatch, rollback, concurrent identical commands, concurrent
different supplier settlements, partial/multi-invoice/excess allocation, roles,
opening commands, existing purchase-builder amounts and ISO date filtering.

`scripts/check_financial_client.mjs` executes the actual client module with faulted
transport adapters, including a committed response loss, reload, changed drafts,
concurrent submits, definite refusal after uncertainty, invalid numbers and opening
recovery. Existing receipt/settlement tests now assert atomic RPC use rather than
the removed compensation and ledger-first write sequences.

Run `npm test`, `npm run typecheck`, and both production builds. Test logs and
rollout evidence are recorded in `logs/FINANCIAL_FOUNDATION_VALIDATION.md`.
The new PostgreSQL/pg packages are pinned development-only test dependencies.
No ADMIN Mobile finance forms or personal-budget persistence are added.

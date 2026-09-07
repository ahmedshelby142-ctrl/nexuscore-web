# NEXUS CORE — documentation

Operational and technical documentation for NEXUS CORE, an Arabic/RTL multi-tenant
ERP: point of sale, inventory, purchasing, wholesale, orders, couriers and an
event-sourced ledger, built on Vite + React and Supabase.

Everything here was written after the production hardening audit of
**6 September 2026** and describes the system **as it actually is**. Where
something is unverified, unfinished or deliberately absent, it says so rather
than describing an intention.

## Index

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system is put together: frontend, Supabase, tenancy, the ledger, licensing, PWA, integrations |
| [SECURITY.md](./SECURITY.md) | Authentication, sessions, RLS and tenant isolation, the leaked-password check, secrets policy, and what is *not* protected |
| [LICENSE_OPERATIONS.md](./LICENSE_OPERATIONS.md) | The manual licence model: the four states, the four actions, and the day-to-day procedure |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build, Vercel, environment variables, Supabase configuration, migrations, PWA rollout |
| [QA_STATUS.md](./QA_STATUS.md) | Production-readiness status with the evidence behind each result |
| [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) | Genuine limitations, each with its impact and what would resolve it |

## Reading order

If you are new to the system, read `ARCHITECTURE.md` first — the ledger and the
tenancy model explain most of the decisions everywhere else.

If you are operating it commercially, `LICENSE_OPERATIONS.md` is the only
document you need day to day.

If you are assessing whether to run it, read `QA_STATUS.md` and then
`KNOWN_LIMITATIONS.md`, in that order.

## What this project is not

* **Not Next.js.** It is a Vite SPA with `react-router-dom`. `vite.config.ts`
  accepts a `NEXT_PUBLIC_` env prefix for compatibility, which has misled people
  before. There is no server runtime, no API routes and no SSR.
* **Not a subscription product.** There is no recurring billing, no payment
  provider integration for subscriptions, and no BASIC/PRO feature gating.
  Licensing is manual and is described in `LICENSE_OPERATIONS.md`.
* **Not offline-capable for data.** The PWA caches the application shell so it
  installs and launches; every read and write goes to Supabase or fails
  honestly. See `KNOWN_LIMITATIONS.md`.

## Other material in this repository

* `docs/migrations/` — the SQL migration history, `000` through `023`. These are
  the authoritative record of the database schema and its policies.
* `docs/NEXUSCORE_*.md`, `docs/phase*-blueprint.md` — historical planning
  documents. They describe intent at the time of writing and have **not** been
  reconciled with the current system; prefer the documents in the index above.
* `supabase/` — mostly legacy scaffolding. The migrations there predate the
  current schema and must not be applied, and the four integration functions are
  **not deployed**. The one exception is `supabase/functions/invite-staff/`,
  which **is** deployed and is what الصلاحيات → إضافة موظف calls. See
  `KNOWN_LIMITATIONS.md`.

# Deployment

## What gets deployed

A static bundle. `vite build` produces `dist/`, Vercel serves it, and the
browser talks to Supabase directly. There is no server runtime, no API route and
no SSR — which is why the security rules all live in Postgres.

## Local commands

```bash
npm install
npm run dev          # Vite dev server
npm run typecheck    # tsc --noEmit
npm test             # node --test "scripts/check_*.mjs"
npm run build        # production build into dist/
npm run preview      # serve dist/ on :4173 — this is what QA runs against
```

`npm test` is the full suite. Some checks talk to the live database with the
publishable key (`scripts/check_rls_anon.mjs`); they skip cleanly when
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are unavailable. No test needs a
secret.

## Environment variables

`vite.config.ts` declares `envPrefix: ["VITE_", "NEXT_PUBLIC_"]`. **Only** those
two prefixes reach the browser. Everything else is invisible to the bundle.

### Required for the app to work

| Variable | Where | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel + `.env.local` | Public. |
| `VITE_SUPABASE_ANON_KEY` | Vercel + `.env.local` | Public by design — it ships in the bundle and resolves to the `anon` role. RLS is what protects the data. |

**If either is missing the build boots into `offline_local` mode**, which is not
a usable mode — every read goes to Supabase, so the screens are empty. The login
screen detects this and refuses with a message naming the two variables rather
than asking for credentials it cannot check. Treat it as a deployment fault.

### Server-side only

Everything in `.env.example` without a `VITE_`/`NEXT_PUBLIC_` prefix —
`SUPABASE_SERVICE_ROLE_KEY`, `PAYMOB_*`, `SHIPPING_*`, `ONLINE_ORDER_*`,
`LICENSE_SIGNING_SECRET`, `INTERNAL_API_KEY` — is for Supabase Edge Functions.
None is bundled. **None of those functions is currently deployed**, so these are
placeholders for future work, not live configuration.

Never put a service-role key in a `VITE_`-prefixed variable. It would ship to
every browser and bypass every policy in this document.

### Files

`.env`, `.env.local`, `.env.*.local` are gitignored. Only `.env.example` is
tracked. Copy it to `.env.local` to develop.

## Vercel

* Project `nexuscore-web1`, team `nexuscore1`.
* Deploys on push to `main` of the `deployed` remote
  (`github.com/ahmedshelby142-ctrl/nexuscore-web1`). `origin`
  (`nexuscore-web`) is the second remote and is not wired to Vercel.
* Build command `vite build`, output `dist`.
* Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the project's
  Environment Variables for the Production environment.

Push to both remotes:

```bash
git push origin main && git push deployed main
```

### Verifying a deployment

Do not assume the SHA. Check it, then check the bundle actually contains the
change:

1. Confirm the production deployment is `READY` and its
   `meta.githubCommitSha` matches `git rev-parse HEAD`.
2. Fetch the production HTML with `cache: "no-store"`, read the
   `assets/index-*.js` filename out of it, fetch that file, and grep for a
   string only the new build contains.

Local and Vercel bundle hashes will **not** match if you build on Windows —
CRLF line endings change the content hash. Compare production against its own
`sw.js` precache list, never against a local filename.

## Supabase configuration

Project `oczgqpxeixlrufvevitz`.

* **Auth → URL Configuration → Redirect URLs** must list every origin people
  sign up from: the production domain, any preview domain in use, and
  `http://localhost:4173` / `http://localhost:5173` for development. Signup
  sends `emailRedirectTo: window.location.origin`, and Supabase refuses an
  origin that is not listed — the account is created, the mail arrives, and the
  link strands the user.
* **Auth → Policies → Leaked password protection** is **off** (it needs a paid
  plan). The client-side check in `src/lib/security.ts` covers the signup form;
  see `KNOWN_LIMITATIONS.md` for what that does not cover.
* **System owners** are the email allowlist inside `is_system_owner()`. Change
  it with a migration, not from the dashboard.

## Migrations

`docs/migrations/` holds the authoritative history, `000` through `021`, applied
in numeric order. Every file is written to be safe to re-run.

To apply one: run it against the project (SQL editor, or the Supabase MCP
`apply_migration`), then commit the file. Applying without committing leaves the
repository lying about the schema, which is how the `orders` policy hole
survived — see `SECURITY.md`.

**`supabase/migrations/` is legacy scaffolding and must not be applied.** It
describes a `profiles`/`is_pro` subscription model this system does not use.

After any policy or schema change, run:

```bash
npm test    # check_rls_anon.mjs re-probes the live database as `anon`
```

## PWA rollout

The service worker uses `registerType: "autoUpdate"` with `skipWaiting` and
`clientsClaim`, so a new deployment takes effect on the next load rather than
waiting for every tab to close. `cleanupOutdatedCaches` removes the previous
precache.

The precache is the **app shell only** — JS, CSS, `index.html`, icons, manifest.
Nothing from Supabase is cached, by design: there is no `runtimeCaching` entry,
and `navigateFallbackDenylist` excludes `/rest/`, `/auth/` and `/functions/`.

### Stale chunks after a deployment

A user with the app open when you deploy may request a code-split chunk that no
longer exists. `vite:preloadError` is handled: the app reloads once, guarded by
a one-shot `sessionStorage` flag so a genuinely broken chunk cannot loop.

If you need to force a client to a new build during testing, unregister the
service worker and clear the Cache Storage for the origin — a plain reload will
otherwise be served the precached shell.

## Rollback

Vercel keeps previous production deployments; promoting one rolls the frontend
back. **Migrations do not roll back with it.** Before rolling the frontend past
a migration boundary, check that the older bundle can still read the current
schema. The additive migrations in this history (`018`–`021`) are safe in that
direction; a column rename would not be.

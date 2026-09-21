# Deployment

## What gets deployed

**Two static bundles, from one repository, as two separate Vercel projects.**

| | Desktop / Web | Mobile PWA |
|---|---|---|
| Entry | `index.html` → `src/main.tsx` | `mobile/index.html` → `src/mobile/main.tsx` |
| Build command | `npm run build` | `npm run build:mobile` |
| Output directory | `dist` | `dist-mobile` |
| Vercel project | `nexuscore-web1` | `nexuscore-mobile` |

Neither has a server runtime, an API route or SSR — the browser talks to
Supabase directly, which is why the security rules all live in Postgres.

### ONLINE-ONLY — no Offline-First

NEXUS CORE is an online-only product. Supabase/Postgres is the authority and the
client is a thin, always-connected reader.

The service worker precaches the **app shell only**. No Supabase REST, Auth or
Realtime response is ever runtime-cached, and there is no background-sync write
queue. A cached shell is **not** permission to write financial data offline:
`commitReceipt` — the single write the mobile app performs — throws with no
local queue, so an offline attempt fails visibly and commits nothing.

Do not add an offline write queue, a local ledger, local document numbering or
a sync-conflict engine to either bundle.

### Why two projects and not one

`vercel.json` build settings override Project Settings for **every** project
linked to this repository. While it pinned `buildCommand`/`outputDirectory`,
a second project could not build anything but the desktop app — which is why
the mobile bundle was built locally and never served.

So the shared `vercel.json` now carries only what is genuinely common: the
`framework` and the SPA rewrite (`/(.*) → /index.html`), which is correct for
both bundles because each serves its own `index.html` from its own output
directory. **Build command and output directory are set per project, in the
Vercel dashboard.** If you put them back in `vercel.json`, the mobile project
silently starts serving the desktop shell again.

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
None is bundled. The integration functions they belong to are **not deployed**,
so those are placeholders for future work rather than live configuration.

Never put a service-role key in a `VITE_`-prefixed variable. It would ship to
every browser and bypass every policy in this document.
`scripts/check_invite_staff.mjs` fails the test run if `service_role` appears
anywhere under `src/`, or under a public prefix in any env file.

### Edge Functions

One is deployed: **`invite-staff`**, with `verify_jwt: true`. It is what
الصلاحيات → إضافة موظف calls, and the only place a service key exists.

* Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` into the function's environment. Nothing needs
  setting by hand.
* **`APP_URL` is optional but recommended.** The invitation link is built as
  `${APP_URL}/set-password`. With it unset the function falls back to the
  inviting admin's browser origin — so an invitation sent from a local preview
  mails the employee a `localhost` link. Set it to the production origin under
  Edge Functions → Secrets.
* `verify_jwt` must stay **on**. With it off, the platform stops rejecting
  anonymous requests and the function's guards become the only line — the
  database would still refuse (that is the design), but there is no reason to
  test it.
* Redeploy after editing `supabase/functions/invite-staff/index.ts`; the
  repository copy is not the deployed copy.

### The invitation redirect must be allowlisted

The link goes to `/set-password`, the screen that turns an invitation into an
account. Supabase replaces any `redirect_to` outside the project's allowlist
with the Site URL, which would drop the employee on a page that cannot consume
their token. Under Authentication → URL Configuration:

* **Site URL** — the production origin.
* **Redirect URLs** — must include the `/set-password` path of every origin an
  invitation can be sent from (production, and the local preview if you test
  from it).

### Email delivery is a separate thing from the invite API

`POST /auth/v1/invite` returning 200 does **not** mean an email arrived. Treat
these as five stages: the invite accepted, the auth user created, the message
generated, SMTP accepting it, and the mailbox receiving it. The first three are
visible in `auth.users` (`invited_at`, `confirmation_sent_at`); the last two are
only visible in the dashboard's Auth logs and in the recipient's mailbox.

**Measured on 8 September 2026: stages 1-3 pass and stage 5 fails.** An
invitation at 01:16:28 UTC and an independent password-recovery message at
02:08:39 UTC were both accepted by Supabase Auth and neither was ever delivered
to the recipient's Gmail — verified directly in that mailbox, including spam and
trash. See `QA_STATUS.md` Part 4.

**Gmail SMTP is for testing, not production.** It is a consumer mailbox, not a
transactional email service: it enforces per-day send caps, silently throttles
automated mail, rewrites the `From` header to the authenticated account, and
gives no delivery telemetry. If invitations matter, use a transactional provider
(Resend, Postmark, SES, SendGrid). If Gmail is kept, it is
**WORKING FOR TESTING / NOT RECOMMENDED FOR PRODUCTION** — and as of the above
date it was not verified working even for testing.

When checking a Gmail SMTP configuration, the things that actually break it:

| Setting | Requirement |
| --- | --- |
| Host / port | `smtp.gmail.com`, port `587` (STARTTLS) |
| Password | A 16-character **App Password**, 2-Step Verification enabled. An account password fails with `535-5.7.8 Username and Password not accepted` |
| Username | The full Gmail address |
| Sender email | **Must equal the username.** Gmail rejects or rewrites a different `From` (`553-5.7.1 … not allowed`) |
| Minimum interval | Leave at the default; Gmail throttles bursts |

"Successfully updated settings" in the dashboard means the form was saved. It is
not evidence that the credentials authenticate or that a message was delivered.
The only proof is a message arriving in a mailbox you can open.

### Files

`.env`, `.env.local`, `.env.*.local` are gitignored. Only `.env.example` is
tracked. Copy it to `.env.local` to develop.

## Vercel

Team `nexuscore1` (`team_uxtO2746GEcTwKAhTEfEourS`). Two projects, both linked
to **`github.com/ahmedshelby142-ctrl/nexuscore-web`** — the `origin` remote —
and both deploying production on push to `main`.

> An earlier version of this file claimed the desktop project deploys from the
> `deployed` remote (`nexuscore-web1`). That was wrong, and it mattered: the
> live deployment's `meta.githubRepo` is `nexuscore-web`. **A push to `origin`
> deploys desktop production.** Corrected 2026-09-21.

### Desktop — `nexuscore-web1`

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | repository root |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

### Mobile — `nexuscore-mobile`

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | repository root |
| Install Command | `npm install` |
| Build Command | `npm run build:mobile` |
| Output Directory | `dist-mobile` |

Root Directory stays at the repository root for both: the mobile entry imports
`src/lib`, the stores and the services, so a narrower root would cut the build
off from its own source.

### Environment variables (both projects)

Each project needs these two, in its own Production environment. They are read
at **build** time and baked into the bundle, so changing one requires a
redeploy, not just a save:

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Nothing else. Every other variable in `.env.example` is server-side and belongs
to the Supabase Edge Functions, never to a browser bundle.

Push:

```bash
git push origin main
```

`origin` is what both Vercel projects build. `deployed`
(`github.com/ahmedshelby142-ctrl/nexuscore-web1`) is a second GitHub remote
that no Vercel project is linked to — pushing there deploys nothing.

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

### The mobile shell must be at the root of `dist-mobile`

The mobile entry HTML lives at `mobile/index.html` so it can sit beside the
desktop `index.html` in the repo, and Vite preserves that path in the output —
so the build used to emit `dist-mobile/mobile/index.html`.

That broke the installed app in two ways: `/` was a 404, and Workbox's
`navigateFallback` is bound to `/index.html`, a URL that was **not** in the
precache manifest (which listed `mobile/index.html`). `createHandlerBoundToURL`
throws on a non-precached URL, so every deep link and every refresh had no
document to fall back to.

The `mobile-shell-at-root` plugin in `vite.mobile.config.ts` renames the emitted
asset in `generateBundle`, so the file is written to `dist-mobile/index.html`
*before* `vite-plugin-pwa` globs the directory and therefore precaches
`index.html`. Nothing inside the HTML needs rewriting — every reference Vite
injects is already absolute.

If you change the mobile entry path or that plugin, re-check the built
`dist-mobile/sw.js`: the precache list must contain `index.html`, and
`createHandlerBoundToURL("/index.html")` must point at it.

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

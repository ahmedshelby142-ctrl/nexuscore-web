/**
 * invite-staff — add a member of staff to the caller's own shop.
 *
 * Creating an auth account needs the service key, and a service key must never
 * reach a browser. That single fact is why this function exists; it is not a
 * place to put business rules.
 *
 * ## Where authorization actually happens
 *
 * Not here. Every question about WHO may invite WHOM is answered by Postgres:
 *
 *   1. `verify_jwt` is on, so Supabase rejects an unauthenticated request
 *      before this code runs.
 *   2. `staff_invite_context()` is called AS THE CALLER. It reads
 *      `store_members` for `auth.uid()`, refuses anyone who is not an ADMIN,
 *      and returns the store id it derived. The request body never says which
 *      store — there is no field for it, and adding one would change nothing,
 *      because step 4 checks again.
 *   3. The service key is used for exactly one thing: creating or inviting the
 *      auth user. It touches no business table.
 *   4. The membership INSERT runs AS THE CALLER too, under the ordinary
 *      `write_store_members` policy (`has_role(store_id,'ADMIN')`). So even if
 *      everything above were bypassed, RLS independently refuses a membership
 *      in a store the caller does not administer.
 *
 * The role is validated against the four the app has, and the column's own
 * CHECK constraint rejects anything else regardless — 'owner', 'superadmin' and
 * friends cannot be written even by a service key.
 *
 * System Owner cannot be granted from here. It is an email allowlist compiled
 * into `is_system_owner()`; changing it takes a migration.
 *
 * ## The membership has to exist before their first sign-in
 *
 * `claim_store` gives an account with NO membership a shop of its own. An
 * invited employee must therefore already be linked by the time they first sign
 * in, or they land in a second, empty shop — the exact failure this whole
 * feature exists to remove. Supabase's invite creates the auth user
 * immediately (they only set a password later), so the order here — create the
 * account, then link it — puts the membership in place long before they arrive.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

/** The only roles that exist. Mirrors `src/lib/roles.ts` and the CHECK constraint. */
const ROLES = ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"] as const;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Where the invitation link should land the employee.
 *
 * It used to be the bare request origin, which was wrong twice over. The origin
 * is the ADMIN's browser, so inviting from a local preview mailed the employee a
 * `localhost` link they could never open; and the root path answers nothing —
 * `/set-password` is the screen that turns the link into an account.
 *
 * `APP_URL` wins when it is set (a function secret, so it does not depend on
 * where the admin happened to be sitting). Otherwise fall back to the caller's
 * origin, which is right in the ordinary case of inviting from the live site.
 * Supabase still has the final say: a URL outside the project's redirect
 * allowlist is replaced with the Site URL.
 */
function acceptUrl(req: Request): string | undefined {
  const base = Deno.env.get("APP_URL") || req.headers.get("origin");
  if (!base) return undefined;
  try {
    return new URL("/set-password", base).toString();
  } catch {
    return undefined;
  }
}

/** One shape for every answer, so the client never has to guess. */
function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    return reply(401, { error: "لازم تكون مسجّل دخول." });
  }

  let email: string;
  let role: string;
  try {
    const body = await req.json();
    email = String(body?.email ?? "").trim().toLowerCase();
    role = String(body?.role ?? "").trim();
  } catch {
    return reply(400, { error: "طلب غير صالح." });
  }

  if (!email) return reply(400, { error: "اكتب إيميل الموظف." });
  if (!(ROLES as readonly string[]).includes(role)) {
    // Reject before touching anything. 'owner', 'system_owner', 'superadmin',
    // 'CASHIER' and every other invented value land here.
    return reply(400, { error: "الصلاحية دي مش موجودة." });
  }

  // Acts as the caller: RLS and every definer function see their auth.uid().
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // 1. Who is calling, which store do they administer, and is this address free?
  const { data: context, error: contextError } = await asCaller.rpc("staff_invite_context", {
    p_email: email,
  });

  if (contextError) {
    // `permission denied for function` is what an `anon` caller gets: the anon
    // key is itself a valid JWT, so the platform admits it and the REVOKE in
    // migration 023 is what actually stops it. Classify it as the refusal it is
    // rather than echoing a Postgres string at the user.
    const denied = /42501|permission denied|not authenticated|admin|belong/i.test(
      contextError.message,
    );
    return reply(denied ? 403 : 400, {
      error: denied ? "مش مسموح لك تضيف موظفين." : contextError.message,
    });
  }

  const storeId = context?.store_id as string | undefined;
  const status = context?.status as string;
  let userId = (context?.user_id as string | null) ?? null;

  if (!storeId) return reply(403, { error: "مش مسموح لك تضيف موظفين." });

  if (status === "already_member") {
    return reply(409, { error: "الشخص ده موجود بالفعل في المحل. عدّل صلاحيته من الجدول." });
  }
  if (status === "belongs_elsewhere") {
    // Deliberately not linkable. One person belongs to one shop — the database
    // enforces it — and silently moving someone out of another tenant is not a
    // decision an invite button should make.
    return reply(409, {
      error: "الإيميل ده مربوط بمحل تاني بالفعل. لازم يتشال من هناك الأول.",
    });
  }

  // 2. The one step that needs the service key: make the account exist.
  let invited = false;
  if (status === "no_account") {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: created, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: acceptUrl(req),
    });

    if (inviteError || !created?.user?.id) {
      const message = inviteError?.message ?? "تعذّر إنشاء الحساب.";
      // Supabase's own SMTP is rate limited. Say so plainly rather than leaving
      // an admin to wonder whether the invite went out.
      const rateLimited = /rate limit/i.test(message);
      return reply(rateLimited ? 429 : 502, {
        error: rateLimited
          ? "تم تجاوز حد إرسال الإيميلات مؤقتاً. جرّب تاني بعد شوية."
          : `تعذّر إرسال الدعوة: ${message}`,
      });
    }
    userId = created.user.id;
    invited = true;
  }

  if (!userId) return reply(500, { error: "تعذّر تحديد حساب الموظف." });

  // 3. Link them — as the caller, under the ordinary RLS policy. If this fails
  //    the account may exist without a membership; that is recoverable (invite
  //    again and it takes the `account_unlinked` path) and is reported honestly
  //    rather than dressed up as success.
  const { error: linkError } = await asCaller
    .from("store_members")
    .insert({ user_id: userId, store_id: storeId, role });

  if (linkError) {
    return reply(403, {
      error: invited
        ? `اتعمل حساب للموظف بس ماتربطش بالمحل: ${linkError.message}`
        : `تعذّر ربط الموظف بالمحل: ${linkError.message}`,
    });
  }

  return reply(200, {
    ok: true,
    user_id: userId,
    role,
    // The client says "invitation sent" only when one actually was.
    invited,
    message: invited
      ? "اتبعتت دعوة على الإيميل. أول ما يقبلها ويحط باسورد هيدخل على المحل ده."
      : "الحساب كان موجود واتربط بالمحل بصلاحيته."
  });
});

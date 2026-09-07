/**
 * الصلاحيات — four fixed roles, one access map.
 *
 *     node --test scripts/check_roles.mjs
 *
 * The bug this guards: the Sidebar used to carry `roles:` per nav item and
 * `App.tsx` carried separate `<RoleGuard>`s around SOME routes. A link could be
 * hidden while its URL stayed open — which is not a hidden screen, it is an
 * unlocked door with the sign taken down. Both now call `canAccess`, so these
 * tests cover the sidebar and the router at once.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  APP_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  canAccess,
  homeFor,
  toAppRole,
} from "../src/lib/roles.ts";

// ── the four, and only the four ─────────────────────────────────────────────

test("there are exactly four roles, all named in Arabic", () => {
  assert.deepEqual(
    [...APP_ROLES],
    ["ADMIN", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT"],
    "no dynamic roles — the set is fixed",
  );
  for (const r of APP_ROLES) {
    assert.ok(ROLE_LABELS[r], `${r} needs a label`);
    assert.ok(ROLE_DESCRIPTIONS[r], `${r} needs a description`);
    assert.ok(
      !/[A-Za-z]/.test(ROLE_LABELS[r]),
      `${ROLE_LABELS[r]} must be Arabic — it reaches the user`,
    );
  }
});

// ── ADMIN opens everything ──────────────────────────────────────────────────

test("ADMIN reaches every screen", () => {
  for (const path of [
    "/", "/products", "/pos", "/inventory", "/purchasing", "/partners",
    "/settings", "/users", "/branches", "/backups", "/wholesale", "/orders",
  ]) {
    assert.ok(canAccess("ADMIN", path), `ADMIN should open ${path}`);
  }
});

// ── the blueprint's named scenario ──────────────────────────────────────────

test("POS_ECOMMERCE is shut out of Treasury, Dashboard, Settings and Purchasing", () => {
  // The exact four the blueprint says must disappear.
  for (const path of ["/partners", "/", "/settings", "/purchasing"]) {
    assert.equal(canAccess("POS_ECOMMERCE", path), false, `${path} must be blocked`);
  }
});

test("POS_ECOMMERCE keeps the screens it works in", () => {
  for (const path of ["/pos", "/orders", "/ecommerce-orders", "/crm", "/returns"]) {
    assert.ok(canAccess("POS_ECOMMERCE", path), `${path} should be open`);
  }
});

test("ECOMMERCE_ONLY gets orders and inventory, not the till", () => {
  for (const path of ["/orders", "/ecommerce-orders", "/inventory"]) {
    assert.ok(canAccess("ECOMMERCE_ONLY", path), `${path} should be open`);
  }
  for (const path of ["/pos", "/purchasing", "/partners", "/settings", "/"]) {
    assert.equal(canAccess("ECOMMERCE_ONLY", path), false, `${path} must be blocked`);
  }
});

test("ACCOUNTANT gets buying and money, not selling", () => {
  for (const path of ["/purchasing", "/inventory", "/partners", "/stock-audit"]) {
    assert.ok(canAccess("ACCOUNTANT", path), `${path} should be open`);
  }
  for (const path of ["/pos", "/crm", "/settings", "/users", "/"]) {
    assert.equal(canAccess("ACCOUNTANT", path), false, `${path} must be blocked`);
  }
});

// ── admin-only screens are admin-only ───────────────────────────────────────

test("nobody but ADMIN reaches settings, users, branches or backups", () => {
  for (const path of ["/settings", "/users", "/branches", "/backups"]) {
    for (const role of APP_ROLES) {
      assert.equal(
        canAccess(role, path),
        role === "ADMIN",
        `${path} for ${role}`,
      );
    }
  }
});

// ── failing shut ────────────────────────────────────────────────────────────

test("an unknown path is closed to everyone except ADMIN", () => {
  // A screen added later without a map entry must fail SHUT for staff.
  for (const role of APP_ROLES) {
    assert.equal(canAccess(role, "/some-new-screen"), role === "ADMIN");
  }
});

test("a missing, empty or nonsense role gets the least privilege", () => {
  for (const bad of [null, undefined, "", "wizard", "root", "ADMINISTRATOR"]) {
    assert.equal(toAppRole(bad), "ECOMMERCE_ONLY", `role ${String(bad)}`);
    assert.equal(canAccess(bad, "/settings"), false, `${String(bad)} must not open settings`);
    assert.equal(canAccess(bad, "/"), false, `${String(bad)} must not open the dashboard`);
  }
});

// ── legacy values keep working ──────────────────────────────────────────────

test("old role strings map onto the fixed four", () => {
  assert.equal(toAppRole("owner"), "ADMIN");
  assert.equal(toAppRole("OWNER"), "ADMIN");
  assert.equal(toAppRole("MANAGER"), "ADMIN");
  assert.equal(toAppRole("cashier"), "POS_ECOMMERCE");
  assert.equal(toAppRole("cashier_data_entry"), "POS_ECOMMERCE");
  assert.equal(toAppRole("CASHIER"), "POS_ECOMMERCE");
  assert.equal(toAppRole("data_entry"), "ECOMMERCE_ONLY");
  assert.equal(toAppRole("VIEWER"), "ECOMMERCE_ONLY");
  assert.equal(toAppRole("accountant"), "ACCOUNTANT");
});

test("branch_manager no longer grants full admin", () => {
  // It used to project onto a complete `owner`, edit:users and all — so anyone
  // holding it could promote themselves.
  assert.notEqual(toAppRole("branch_manager"), "ADMIN");
  assert.equal(canAccess("branch_manager", "/users"), false, "cannot hand out roles");
  assert.equal(canAccess("branch_manager", "/settings"), false);
});

test("a role already canonical passes through unchanged", () => {
  for (const r of APP_ROLES) assert.equal(toAppRole(r), r);
});

// ── redirects can never loop ────────────────────────────────────────────────

test("every role's landing screen is one it can actually open", () => {
  // A redirect target the role is blocked from would bounce forever.
  for (const role of APP_ROLES) {
    const home = homeFor(role);
    assert.ok(home, `${role} needs a home`);
    assert.ok(canAccess(role, home), `${role} is redirected to ${home} but cannot open it`);
  }
});

test("a blocked user lands somewhere real, even with a junk role", () => {
  const home = homeFor("wizard");
  assert.ok(canAccess("wizard", home), "the fallback role must be able to open its own home");
});

// ── path matching ───────────────────────────────────────────────────────────

test("a nested path resolves like its top-level screen", () => {
  assert.equal(canAccess("POS_ECOMMERCE", "/orders/abc-123"), true);
  assert.equal(canAccess("POS_ECOMMERCE", "/purchasing/x"), false, "depth is not a way in");
});

test("a query string is not a way past the guard", () => {
  assert.equal(canAccess("POS_ECOMMERCE", "/settings?tab=general"), false);
  assert.equal(canAccess("ACCOUNTANT", "/users?x=1"), false);
});

test("the users screen does not promise a self-service join that does not exist", async () => {
  // It used to read: "الموظف بيعمل حساب بنفسه من شاشة الدخول... وبعدين يظهر هنا".
  // They do not appear here. `claim_store` gives an account with no membership
  // a shop OF ITS OWN, as ADMIN of it, so an unprompted signup lands in a
  // separate empty tenant — and `list_store_members` only ever returns members
  // of the caller's own store, so the new hire is invisible to their employer.
  //
  // Found in the roles audit, 2026-09-07. The first correction pointed the
  // owner at إدارة النظام, because linking was a manual step and nothing in the
  // app could do it. `invite-staff` now can, so the screen offers the button —
  // but the warning stays, since it is the reason to use the button rather than
  // let a new hire sign up on their own. See scripts/check_invite_staff.mjs.
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(
    new URL("../src/components/auth/UserManagementPanel.tsx", import.meta.url),
    "utf8",
  )
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")   // JSX comments explain the old copy
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    !/يظهر هنا وتحدد له/.test(panel),
    "the screen claims a signed-up employee appears in this list — they do not",
  );
  assert.match(
    panel,
    /إضافة موظف/,
    "the screen must offer the action that actually adds someone",
  );
  assert.match(
    panel,
    /محل جديد|محل فاضي/,
    "it must warn that an unlinked signup creates a separate shop",
  );
});

test("claim_store still hands an unlinked signup its own shop", async () => {
  // The reason the copy above has to say what it says. If this ever changes —
  // if signup starts joining an existing store — the warning becomes wrong and
  // this test is where that gets noticed.
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(
    new URL("../docs/migrations/019_claim_store_onboarding.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /INSERT INTO public\.stores \(id, name\)/, "signup creates a store");
  assert.match(
    sql,
    /INSERT INTO public\.store_members[\s\S]{0,80}'ADMIN'/,
    "and makes the signer ADMIN of it",
  );
});

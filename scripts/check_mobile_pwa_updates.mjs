/**
 * Mobile PWA updates: an open app finds a new release and reloads into it —
 * never while the user has something typed.
 *
 * Live finding (503fe30 → c8b337c): the first load after a deployment ran the
 * OLD bundle (`C6SOAOVi`) and only a manual refresh showed the new one
 * (`3KQlFe8n`). The injected `registerSW.js` registered the worker and did
 * nothing else: no update check while open, no reload when a new worker took
 * over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const { createUpdateLifecycle, unsafeReloadReason } = await import(new URL("src/mobile/pwa/updateLifecycle.ts", root).href);

// ── A minimal document ──────────────────────────────────────────────────────
const el = (tagName, props = {}) => ({ tagName, type: "text", value: "", readOnly: false, disabled: false, isContentEditable: false, ...props });
const doc = ({ active = null, dialog = false, fields = [] } = {}) => ({
  activeElement: active,
  querySelector: (sel) => (dialog && /dialog/.test(sel) ? {} : null),
  querySelectorAll: () => fields,
});

test("safe: nothing focused, no dialog, every text field empty", () => {
  assert.equal(unsafeReloadReason(doc({ fields: [el("INPUT"), el("TEXTAREA")] })), null);
  assert.equal(unsafeReloadReason(doc({ active: el("BUTTON") })), null);
});

test("unsafe: typing, an open sheet, or any typed value anywhere on the page", () => {
  assert.equal(unsafeReloadReason(doc({ active: el("INPUT") })), "typing", "even an empty focused field — the user is about to type");
  assert.equal(unsafeReloadReason(doc({ active: el("DIV", { isContentEditable: true }) })), "typing");
  assert.equal(unsafeReloadReason(doc({ dialog: true })), "dialog-open");
  assert.equal(unsafeReloadReason(doc({ fields: [el("INPUT", { type: "email", value: "a@b.c" })] })), "unsaved-input", "a half-filled login");
  assert.equal(unsafeReloadReason(doc({ fields: [el("TEXTAREA", { value: "ملاحظة" })] })), "unsaved-input");
  assert.equal(unsafeReloadReason(doc({ fields: [el("INPUT", { type: "number", value: "3" })] })), "unsaved-input", "a restock quantity");
});

test("not work: checkboxes, hidden and disabled/read-only fields, selects", () => {
  const fields = [el("INPUT", { type: "checkbox", value: "on" }), el("INPUT", { type: "hidden", value: "x" }), el("INPUT", { value: "x", disabled: true }), el("INPUT", { value: "x", readOnly: true }), el("SELECT", { value: "a" })];
  assert.equal(unsafeReloadReason(doc({ fields })), null);
});

// ── The lifecycle, with a fake clock ────────────────────────────────────────
function harness({ safe = true, visible = true } = {}) {
  const h = { t: 0, checks: 0, reloads: 0, safe, visible, intervals: [], timeouts: [] };
  h.life = createUpdateLifecycle({
    checkForUpdate: () => { h.checks++; },
    reload: () => { h.reloads++; },
    isSafe: () => h.safe,
    isVisible: () => h.visible,
    setInterval: (fn, ms) => h.intervals.push({ fn, ms }),
    setTimeout: (fn, ms) => h.timeouts.push({ fn, ms }),
    now: () => h.t,
  });
  h.tick = () => h.intervals.forEach((i) => i.fn());
  h.runTimeouts = () => { const due = h.timeouts.splice(0); due.forEach((t) => t.fn()); };
  return h;
}

test("detection: the open app asks for a new release every minute while visible, not while hidden", () => {
  const h = harness();
  assert.equal(h.intervals[0].ms, 60_000);
  h.tick(); assert.equal(h.checks, 1);
  h.visible = false; h.tick(); assert.equal(h.checks, 1, "a backgrounded phone is not polled");
  h.visible = true; h.life.visibilityChanged(); assert.equal(h.checks, 2, "coming back to the app asks at once");
  h.life.online(); assert.equal(h.checks, 3, "so does reconnecting");
});

test("navigation asks too, at most every 30 s", () => {
  const h = harness();
  h.life.navigated(); assert.equal(h.checks, 1);
  h.t = 10_000; h.life.navigated(); assert.equal(h.checks, 1);
  h.t = 31_000; h.life.navigated(); assert.equal(h.checks, 2);
});

test("activation while idle reloads at once — exactly once", () => {
  const h = harness();
  h.life.updateActivated(); assert.equal(h.reloads, 1);
  h.life.updateActivated(); h.life.navigated(); h.life.visibilityChanged();
  assert.equal(h.reloads, 1, "no reload loop");
  h.tick(); assert.equal(h.checks, 0, "a page on its way out stops asking");
});

test("activation while the user is typing waits; nothing is reloaded until it is safe", () => {
  const h = harness({ safe: false });
  h.life.updateActivated();
  assert.equal(h.reloads, 0);
  assert.equal(h.timeouts.length, 1); assert.equal(h.timeouts[0].ms, 15_000);
  h.runTimeouts(); assert.equal(h.reloads, 0, "still typing");
  assert.equal(h.timeouts.length, 1, "one retry pending, not a pile of them");
  h.life.navigated(); h.life.navigated();
  assert.equal(h.timeouts.length, 1);
  h.safe = true;
  h.life.navigated(); assert.equal(h.reloads, 1, "the next navigation is the safe point");
});

test("a deferred update also lands when the app is backgrounded, or on the retry timer", () => {
  const a = harness({ safe: false });
  a.life.updateActivated(); a.safe = true; a.visible = false; a.life.visibilityChanged();
  assert.equal(a.reloads, 1);
  const b = harness({ safe: false });
  b.life.updateActivated(); b.safe = true; b.runTimeouts();
  assert.equal(b.reloads, 1);
});

test("a failing update check (offline, mid-deploy) is swallowed and retried on the next tick", async () => {
  let calls = 0;
  const life = createUpdateLifecycle({
    checkForUpdate: () => { calls++; return Promise.reject(new Error("offline")); },
    reload: () => {}, isSafe: () => true, isVisible: () => true,
    setInterval: () => {}, setTimeout: () => {}, now: () => 0,
  });
  life.online(); await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test("wiring: our registration replaces the injected one, keeps the worker's cache rules, and hooks navigation", () => {
  const config = read("vite.mobile.config.ts");
  assert.match(config, /injectRegister: false,/);
  for (const rule of ["registerType: \"autoUpdate\"", "cleanupOutdatedCaches: true", "clientsClaim: true", "skipWaiting: true", "navigateFallback: \"/index.html\""]) {
    assert.ok(config.includes(rule), `unchanged: ${rule}`);
  }
  assert.match(config, /globPatterns: \["\*\*\/\*\.\{js,css,html,ico,png,svg,woff2\}"\]/, "no API response is ever cached");
  const reg = read("src/mobile/pwa/registerMobileUpdates.ts");
  assert.match(reg, /onNeedReload: \(\) => lifecycle\?\.updateActivated\(\)/, "never the plugin's unconditional reload");
  assert.match(reg, /isSafe: \(\) => unsafeReloadReason\(document\) === null/);
  assert.match(reg, /if \(!import\.meta\.env\.PROD \|\| !\("serviceWorker" in navigator\)\) return;/);
  assert.match(read("src/mobile/main.tsx"), /void registerMobileUpdates\(\);/);
  assert.match(read("src/mobile/MobileApp.tsx"), /useEffect\(\(\) => \{\n\s*notifyMobileNavigation\(\);\n\s*\}, \[pathname\]\);/);
});

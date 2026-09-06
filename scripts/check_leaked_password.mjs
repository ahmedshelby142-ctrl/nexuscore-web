/**
 * The breach check: what leaves the browser, and what it does when it fails.
 *
 *     node --test scripts/check_leaked_password.mjs
 *
 * Two ways this goes wrong, and they pull in opposite directions:
 *
 *   * it leaks the password (or enough of its hash to identify it), which is
 *     the whole reason the k-anonymity range API exists;
 *   * it fails CLOSED, so an outage at a third party stops people opening
 *     accounts — a free advisory check taking the signup form down with it.
 *
 * Every request is stubbed. Nothing here touches the network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkLeakedPassword, LEAKED_PASSWORD_MESSAGE } from "../src/lib/security.ts";

/** "password" — the canonical example from the range API's own docs. */
const PASSWORD = "password";
const SHA1 = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8";
const PREFIX = "5BAA61";
const SUFFIX = SHA1.slice(5);

/** A stub that records what it was asked for and answers with `body`. */
function stub(body, { status = 200, calls = [] } = {}) {
  return Object.assign(
    async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      };
    },
    { calls },
  );
}

/** Silence the warnings the fallback path is supposed to emit, and count them. */
function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  return Promise.resolve(fn()).then(
    (value) => {
      console.warn = original;
      return { value, lines };
    },
    (error) => {
      console.warn = original;
      throw error;
    },
  );
}

// ── What leaves the browser ─────────────────────────────────────────────────

test("only the first five characters of the hash are sent", async () => {
  const fetchImpl = stub(`${SUFFIX}:37359`);
  await checkLeakedPassword(PASSWORD, { fetchImpl });

  const { url } = fetchImpl.calls[0];
  assert.equal(url, `https://api.pwnedpasswords.com/range/${SHA1.slice(0, 5)}`);

  // The three things that must never appear in the request. Checked against
  // the path segment we control, not the whole URL — the host is
  // `api.pwnedpasswords.com`, which contains the literal string "password" and
  // fails a naive substring check on this very test vector.
  const sent = url.slice(url.lastIndexOf("/") + 1);
  assert.ok(!sent.includes(PASSWORD), "the password is in the request path");
  assert.ok(!sent.includes(SHA1), "the full hash is in the request path");
  assert.ok(!sent.includes(SUFFIX), "the hash suffix is in the request path");
  // Five characters, no more: a sixth narrows the anonymity set 16-fold.
  assert.equal(sent.length, 5);
});

test("the request carries no credentials and asks for padding", async () => {
  const fetchImpl = stub(`${SUFFIX}:1`);
  await checkLeakedPassword(PASSWORD, { fetchImpl });

  const { init } = fetchImpl.calls[0];
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit", "no cookie should ride along to a third party");
  assert.equal(
    init.headers["Add-Padding"],
    "true",
    "without padding the response SIZE leaks whether the prefix set is large",
  );
});

test("the hash is SHA-1, uppercase, and matches the published vector", async () => {
  // If this drifts, every lookup silently returns "not found" — the check would
  // pass everything and nobody would notice.
  const fetchImpl = stub(`${SUFFIX}:37359`);
  const leaked = await checkLeakedPassword(PASSWORD, { fetchImpl });
  assert.equal(leaked, true, "'password' is the most-breached password there is");
  assert.ok(fetchImpl.calls[0].url.endsWith(PREFIX.slice(0, 5)));
});

// ── Reading the answer ──────────────────────────────────────────────────────

test("a suffix in the list with a real count is a leak", async () => {
  const body = ["0018A45C4D1DEF81644B54AB7F969B88D65:1", `${SUFFIX}:37359`, "011053FD0102E94D6AE2F8B83D76FAF94F6:2"].join("\r\n");
  assert.equal(await checkLeakedPassword(PASSWORD, { fetchImpl: stub(body) }), true);
});

test("a suffix that is not in the list is safe", async () => {
  const body = ["0018A45C4D1DEF81644B54AB7F969B88D65:1", "011053FD0102E94D6AE2F8B83D76FAF94F6:2"].join("\r\n");
  assert.equal(await checkLeakedPassword(PASSWORD, { fetchImpl: stub(body) }), false);
});

test("a padding entry is not a leak", async () => {
  // `Add-Padding: true` fills the response with decoy suffixes carrying a count
  // of zero. Counting one as a match would tell a user with a perfectly good
  // password that it had been breached — and the more padding, the likelier.
  const body = `${SUFFIX}:0`;
  assert.equal(
    await checkLeakedPassword(PASSWORD, { fetchImpl: stub(body) }),
    false,
    "a zero count is padding, not a breach",
  );
});

test("the comparison ignores case and stray whitespace", async () => {
  const body = `  ${SUFFIX.toLowerCase()} : 12 \r\n`;
  assert.equal(await checkLeakedPassword(PASSWORD, { fetchImpl: stub(body) }), true);
});

test("an empty password is not looked up at all", async () => {
  const fetchImpl = stub("");
  assert.equal(await checkLeakedPassword("", { fetchImpl }), false);
  assert.equal(fetchImpl.calls.length, 0, "nothing should be requested for an empty field");
});

// ── Failing open ────────────────────────────────────────────────────────────

test("a network error lets the signup through, with a warning", async () => {
  const { value, lines } = await captureWarnings(() =>
    checkLeakedPassword(PASSWORD, {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  );
  assert.equal(value, false, "an outage must not block registration");
  assert.equal(lines.length, 1, "and must say so in the console");
});

test("a non-200 answer lets the signup through", async () => {
  const { value, lines } = await captureWarnings(() =>
    checkLeakedPassword(PASSWORD, { fetchImpl: stub("", { status: 503 }) }),
  );
  assert.equal(value, false);
  assert.match(lines[0], /503/);
});

test("a hung request is abandoned and lets the signup through", async () => {
  const { value, lines } = await captureWarnings(() =>
    checkLeakedPassword(PASSWORD, {
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    }),
  );
  assert.equal(value, false, "a slow third party must not hold the form open");
  assert.match(lines[0], /timed out/);
});

test("nothing about the password reaches the console", async () => {
  const { lines } = await captureWarnings(() =>
    checkLeakedPassword(PASSWORD, {
      fetchImpl: async () => {
        throw new Error("boom");
      },
    }),
  );
  const logged = lines.join(" ");
  for (const secret of [PASSWORD, SHA1, SUFFIX, SHA1.slice(0, 5)]) {
    assert.ok(!logged.includes(secret), `"${secret.slice(0, 8)}…" was logged`);
  }
});

test("a body that is not the expected shape is treated as no match", async () => {
  for (const body of ["", "<html>down for maintenance</html>", "garbage\nlines\nwithout colons"]) {
    assert.equal(await checkLeakedPassword(PASSWORD, { fetchImpl: stub(body) }), false);
  }
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the signup flow checks before it creates the account", async () => {
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(new URL("../src/pages/Login.tsx", import.meta.url), "utf8");

  const check = login.indexOf("checkLeakedPassword(password");
  const signUp = login.indexOf("sb.auth.signUp(");
  assert.ok(check > 0, "signup must call the breach check");
  assert.ok(signUp > 0, "signup must still exist");
  assert.ok(
    check < signUp,
    "the check runs AFTER signUp — the account would already exist by then",
  );

  // And it must stop, not merely warn.
  const between = login.slice(check, signUp);
  assert.match(between, /return;/, "a leaked password must halt the flow");
});

test("the change-password flow checks too", async () => {
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(new URL("../src/pages/Login.tsx", import.meta.url), "utf8");
  assert.match(
    login,
    /checkLeakedPassword\(newPassword\)/,
    "a password chosen at a change screen is no safer for being the second one",
  );
});

test("the user-facing message says what happened and what to do", () => {
  assert.match(LEAKED_PASSWORD_MESSAGE, /data breach/i);
  assert.match(LEAKED_PASSWORD_MESSAGE, /choose a different password/i);
});

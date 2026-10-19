import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { uiHarness } from "./helpers/ui-harness.mjs";

const require = createRequire(import.meta.url);
function fixture({ admin = false, eligible = true, url = "/pos", mobile = false } = {}) {
  const calls = [],
    mounted = { selling: 0, unmounted: 0 };
  const h = uiHarness({
    "@/store/useAuthStore": {
      useAuthStore: (selector) => selector({ userRole: admin ? "ADMIN" : "CASHIER_ONLY" }),
    },
    "./useAlertBadges": { useAlertBadges: () => ({}) },
    "@/lib/supabase": { getSupabaseClient: () => null },
    "@/services/api/storeContext": { getSyncIdentity: async () => null },
    "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
    "@/lib/financialCommand": {
      runFinancialCommand() {
        throw Error("No financial write from navigation test");
      },
      resolvePendingFinancialCommand() {},
    },
  });
  const router = require("react-router-dom"),
    { React } = h;
  const model = {
    eligible,
    loading: false,
    busy: false,
    error: "",
    canSell: true,
    overrideReason: "",
    setOverrideReason() {},
    data: {
      enabled: true,
      admin,
      policy: {
        cashier_id: "synthetic-cashier",
        revision: 1,
        opening_piastre: 50000,
        keep_piastre: 50000,
      },
      shift: {
        id: "synthetic-shift",
        cashier_id: "synthetic-cashier",
        revision: 1,
        shift_day: "2026-10-18",
        status: "open",
        opened_at: "2026-10-18T08:00:00Z",
        planned_end_at: "2026-10-18T16:00:00Z",
        opening_piastre: 50000,
        keep_piastre: 50000,
        live_expected_piastre: 270000,
        expected_piastre: null,
        actual_piastre: null,
        variance_piastre: null,
        retained_piastre: null,
        handover_piastre: null,
        cash_sales_piastre: 250000,
        cash_refunds_piastre: 10000,
        cash_expenses_piastre: 20000,
        other_cash_piastre: 0,
        electronic: [],
        movements: [],
      },
      cashiers: [{ id: "synthetic-cashier", email: "synthetic@qa.invalid" }],
      history: [],
      audit: [],
      allocatable: [],
    },
    refresh: async () => calls.push(["refresh"]),
    resolve: async () => calls.push(["resolve"]),
    execute: async (...args) => calls.push(args),
  };
  const Workspace = h.load("src/components/sales/CashierShiftWorkspace.tsx").CashierShiftWorkspace;
  function Selling() {
    const [value, setValue] = React.useState("");
    React.useEffect(() => {
      mounted.selling++;
      return () => {
        mounted.unmounted++;
      };
    }, []);
    return React.createElement(
      "label",
      null,
      "مسودة البيع المحلية",
      React.createElement("input", {
        value,
        onChange: (e) => setValue(e.target.value),
      }),
    );
  }
  function HistoryControls() {
    const location = router.useLocation(),
      navigate = router.useNavigate();
    return React.createElement(
      "div",
      null,
      React.createElement(
        "output",
        { "data-testid": "location" },
        location.pathname + location.search,
      ),
      React.createElement("button", { onClick: () => navigate(-1) }, "Previous view"),
      React.createElement("button", { onClick: () => navigate(1) }, "Next view"),
    );
  }
  return {
    h,
    model,
    calls,
    mounted,
    router,
    Workspace,
    async render(children = React.createElement(Selling), afterWorkspace = null) {
      return h.render(() =>
        React.createElement(
          router.MemoryRouter,
          { initialEntries: [url] },
          React.createElement(HistoryControls),
          React.createElement(
            Workspace,
            { model, mobile, ...(mobile ? { homeLabel: "الرئيسية" } : {}) },
            children,
          ),
          afterWorkspace,
        ),
      );
    },
  };
}

for (const admin of [false, true])
  test(`selling view excludes the shift panel from access/focus; admin=${admin}`, async () => {
    const f = fixture({ admin });
    try {
      await f.render();
      assert.ok(f.h.getByLabelText(document.body, "مسودة البيع المحلية"));
      assert.equal(f.h.queryByRole(document.body, "region", { name: "وردية الكاشير" }), null);
      assert.equal(
        f.h.getByRole(document.body, "link", { name: "نقطة البيع" }).getAttribute("aria-current"),
        "page",
      );
      const management = document.querySelector(".shift-management-view");
      assert.equal(management.hidden, true);
      assert.ok(management.hasAttribute("inert"));
      assert.equal(f.calls.length, 0);
    } finally {
      await f.h.cleanup();
    }
  });

test("URL navigation/back/forward preserves the same mounted selling draft, shift count and confirmation", async () => {
  const f = fixture({ url: "/pos?receipt=keep" });
  try {
    const user = await f.render();
    const draft = f.h.getByLabelText(document.body, "مسودة البيع المحلية");
    await f.h.perform(() => user.type(draft, "barcode / cart draft"));
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "link", { name: "إدارة الوردية والعهدة" })),
    );
    assert.equal(
      f.h.getByTestId(document.body, "location").textContent,
      "/pos?receipt=keep&view=shift",
    );
    assert.equal(
      f.h
        .queryByLabelText(document.body, "مسودة البيع المحلية", { selector: "input:not([hidden])" })
        ?.closest(".shift-selling-view").hidden,
      true,
    );
    assert.equal(document.activeElement.id, "cashier-shift-page-title");
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "button", { name: "تفاصيل الوردية والإقفال" })),
    );
    const count = f.h.getByLabelText(document.body, "النقدية الفعلية الموجودة (جنيه)"),
      confirmed = f.h.getByLabelText(
        document.body,
        "عدَدت النقدية فعليًا وأوقفت معاملات هذه الوردية",
      );
    await f.h.perform(() => user.type(count, "2700"));
    await f.h.perform(() => user.click(confirmed));
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "button", { name: "Previous view" })),
    );
    assert.equal(draft.value, "barcode / cart draft");
    assert.equal(draft.closest(".shift-selling-view").hidden, false);
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "button", { name: "Next view" })),
    );
    assert.equal(count.value, "2700");
    assert.equal(confirmed.checked, true);
    assert.equal(f.mounted.selling, 1);
    assert.equal(f.mounted.unmounted, 0);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.h.cleanup();
  }
});

for (const admin of [false, true])
  test(`direct shift URL uses original role-adapted panel and exact model; admin=${admin}`, async () => {
    const f = fixture({ admin, url: "/pos?view=shift" });
    try {
      const user = await f.render();
      assert.ok(
        f.h.getByRole(document.body, "heading", { name: "إدارة الوردية والعهدة", level: 1 }),
      );
      assert.equal(document.querySelector(".shift-selling-view").hidden, true);
      assert.equal(document.querySelector(".shift-management-view").hidden, false);
      assert.equal(!!f.h.queryByText(document.body, "سياسة العهدة — للمدير فقط"), admin);
      assert.ok(
        f.h
          .getByRole(document.body, "group", { name: "ملخص نقدية الوردية" })
          .textContent.includes("٢٬٧٠٠٫٠٠"),
      );
      await f.h.perform(() =>
        user.click(f.h.getByRole(document.body, "button", { name: "تحديث الوردية" })),
      );
      assert.deepEqual(f.calls, [["refresh"]]);
    } finally {
      await f.h.cleanup();
    }
  });

test("a forged query cannot turn an ineligible/stale-admin model into shift access", async () => {
  const f = fixture({ admin: true, eligible: false, url: "/pos?view=shift" });
  try {
    await f.render();
    assert.equal(
      f.h.queryByRole(document.body, "navigation", { name: "عرض الوردية والعمليات" }),
      null,
    );
    assert.equal(document.querySelector(".cashier-shift-panel"), null);
    assert.equal(document.querySelector(".shift-selling-view").hidden, false);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.h.cleanup();
  }
});

test("mobile uses its existing Home URL and leaves navigation out of financial operations", async () => {
  const f = fixture({ mobile: true, url: "/?filter=keep" });
  try {
    const user = await f.render();
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "link", { name: "إدارة الوردية والعهدة" })),
    );
    assert.equal(
      f.h.getByTestId(document.body, "location").textContent,
      "/?filter=keep&view=shift",
    );
    await f.h.perform(() => user.click(f.h.getByRole(document.body, "link", { name: "الرئيسية" })));
    assert.equal(f.h.getByTestId(document.body, "location").textContent, "/?filter=keep");
    assert.deepEqual(f.calls, []);
  } finally {
    await f.h.cleanup();
  }
});

for (const admin of [false, true])
  test(`actual Mobile bottom Home returns from shift view without a new nav permission; admin=${admin}`, async () => {
    const f = fixture({ admin, mobile: true, url: "/?view=shift" });
    try {
      const BottomNav = f.h.load("src/mobile/shell/MobileBottomNav.tsx").MobileBottomNav;
      const user = await f.render(
        undefined,
        f.h.React.createElement(BottomNav, { onOpenMore() {} }),
      );
      const nav = f.h.getByRole(document.body, "navigation", { name: "التنقل الرئيسي" });
      assert.equal(f.h.getAllByRole(nav, "link").length, admin ? 3 : 1);
      assert.equal(!!f.h.queryByRole(nav, "link", { name: "المالية" }), admin);
      await f.h.perform(() => user.click(f.h.getByRole(nav, "link", { name: "الرئيسية" })));
      assert.equal(f.h.getByTestId(document.body, "location").textContent, "/");
      assert.equal(document.querySelector(".shift-selling-view").hidden, false);
      assert.equal(f.mounted.selling, 1);
      assert.deepEqual(f.calls, []);
    } finally {
      await f.h.cleanup();
    }
  });

test("loading/error/recovery and disabled close survive the dedicated view", async () => {
  const f = fixture({ url: "/pos?view=shift" });
  f.model.data = null;
  f.model.loading = true;
  f.model.error = "Synthetic read failure";
  try {
    const user = await f.render();
    assert.equal(document.querySelector(".cashier-shift-panel").getAttribute("aria-busy"), "true");
    assert.ok(f.h.getByRole(document.body, "alert"));
    assert.equal(f.h.getByRole(document.body, "button", { name: "تحديث الوردية" }).disabled, true);
    await f.h.perform(() =>
      user.click(f.h.getByRole(document.body, "button", { name: "تأكيد نتيجة المحاولة السابقة" })),
    );
    assert.deepEqual(f.calls, [["resolve"]]);
  } finally {
    await f.h.cleanup();
  }
});

test("existing direct-URL route guard still denies Online Only, Accountant and unverified access to POS", async () => {
  for (const role of ["ECOMMERCE_ONLY", "ACCOUNTANT", "UNVERIFIED", "MODERATOR"]) {
    const h = uiHarness({
      "@/store/useAuthStore": { useAuthStore: (selector) => selector({ userRole: role }) },
    });
    const router = require("react-router-dom"),
      { RequireAccess } = h.load("src/components/auth/RequireAccess.tsx");
    try {
      await h.render(() =>
        h.React.createElement(
          router.MemoryRouter,
          { initialEntries: ["/pos?view=shift"] },
          h.React.createElement(
            router.Routes,
            null,
            h.React.createElement(
              router.Route,
              { element: h.React.createElement(RequireAccess) },
              h.React.createElement(router.Route, {
                path: "/pos",
                element: h.React.createElement("p", null, "Protected POS content"),
              }),
            ),
            h.React.createElement(router.Route, {
              path: "*",
              element: h.React.createElement("p", null, "Existing safe destination"),
            }),
          ),
        ),
      );
      assert.equal(h.queryByText(document.body, "Protected POS content"), null, role);
      assert.ok(h.getByText(document.body, "Existing safe destination"));
    } finally {
      await h.cleanup();
    }
  }
});

test("Desktop/Mobile keep their one original model and pass it unchanged into the new visual host", () => {
  const pos = fs.readFileSync("src/routes/pos.tsx", "utf8"),
    home = fs.readFileSync("src/mobile/screens/MobileHomeScreen.tsx", "utf8");
  assert.equal((pos.match(/useCashierShift\(\)/g) ?? []).length, 1);
  assert.equal((home.match(/useCashierShift\(\)/g) ?? []).length, 1);
  assert.match(pos, /<CashierShiftWorkspace model=\{shift\}>/);
  assert.match(pos, /<CheckoutForm shift=\{shift\}/);
  assert.match(home, /<CashierShiftWorkspace model=\{cashierShift\} homeLabel="الرئيسية" mobile>/);
  assert.doesNotMatch(pos + home, /<CashierShiftPanel/);
});

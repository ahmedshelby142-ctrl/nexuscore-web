import { format } from "date-fns";
import { formatMoney } from "@/lib/math";
import type { WalletType } from "@/types";
import { useSettingsStore } from "@/store/useSettingsStore";

interface PDFReportData {
  companyName: string;
  reportDate: Date;
  financialSummary: {
    totalSales: number;
    totalExpenses: number;
    netProfit: number;
    shippingProfit: number;
  };
  walletBalances: { type: WalletType; label: string; balance: number }[];
  shareholderDistributions: {
    name: string;
    capitalContributed: number;
    sharePercentage: number;
    /** Draws already taken in the period — an advance on the share. */
    drawsTaken: number;
    currentShare: number;
  }[];
  expenses: { category: string; amount: number; description?: string; date: Date }[];
}

// ── How a report reaches paper/PDF, without a popup ───────────────────────

/**
 * Render a finished report document and open the print dialog for it.
 *
 * Every report used to do `window.open("", "_blank")`. The desktop WebView
 * blocks that, so every PDF button in the app did nothing at all — no window,
 * no error the user could act on. The document is now written into a hidden
 * iframe INSIDE the page: no popup to block, and the browser/WebView print
 * dialog (with "Save as PDF" / "Microsoft Print to PDF") comes up as before.
 *
 * If printing is unavailable, the same document is saved to disk instead —
 * the identical Blob + `<a download>` path the Excel template already uses —
 * so the button always produces something the user can open and print.
 *
 * ponytail: printing is fire-and-forget; the caller gets no callback. Nothing
 * in the app needs to know when the dialog closed.
 */
function printReport(html: string, fileName: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = html;

  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      saveReportFile(html, fileName);
      return;
    }
    // Take the frame away once the dialog is done with it. The backstop
    // covers engines that never fire afterprint, so frames cannot pile up.
    win.addEventListener("afterprint", () => frame.remove(), { once: true });
    setTimeout(() => frame.remove(), 60_000);
    try {
      win.focus();
      win.print();
    } catch {
      frame.remove();
      saveReportFile(html, fileName);
    }
  };

  document.body.appendChild(frame);
}

/** Last resort: hand the user the report as a file they can open and print. */
function saveReportFile(html: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}.html`;
  a.click();
  URL.revokeObjectURL(url);
  alert("تعذّر فتح نافذة الطباعة، فاتحفظ التقرير كملف. افتحه واطبعه أو احفظه PDF.");
}

// ── Who the paper says it is ──────────────────────────────────────────────

/**
 * The shop's identity, as the owner typed it in الإعدادات ← عام.
 *
 * `useSettingsStore` used to be write-only: the owner could set اسم المحل,
 * الهاتف, العنوان, الرقم الضريبي and نسبة الضريبة, and NOTHING in the app ever
 * read them back — every printed document said "NexusCore" (or, on the
 * wholesale invoice, a hardcoded "راديانت"). Reading the store here, at the
 * one place every report is built, is what makes الإعدادات ripple onto paper.
 *
 * `getState()` rather than the hook because printing is a one-shot call from
 * an event handler, not a render. The value is read at print time, so the
 * document always carries the name the shop has right now.
 */
export function storeIdentity(): {
  name: string;
  phone: string;
  address: string;
  taxNumber: string;
  vatRate: number;
} {
  const s = useSettingsStore.getState();
  return {
    // The store's own default is "محلي"; treat a blank name as "not set" and
    // fall back to the product name so a header is never empty.
    name: s.storeName?.trim() || "NexusCore",
    phone: s.phoneNumber?.trim() || "",
    address: s.address?.trim() || "",
    taxNumber: s.taxNumber?.trim() || "",
    vatRate: Number.isFinite(s.vatRate) ? s.vatRate : 0,
  };
}

/** The contact line under the shop name — only the fields that are filled. */
function storeContactLine(): string {
  const s = storeIdentity();
  const parts = [
    s.phone && `هاتف: ${s.phone}`,
    s.address,
    s.taxNumber && `الرقم الضريبي: ${s.taxNumber}`,
  ].filter(Boolean) as string[];
  return parts.map(escapeHtml).join(" — ");
}

// ── Generic table-to-PDF (Phase F) ────────────────────────────────────────

export interface TablePdfColumn<T> {
  /** Arabic header label, e.g. "رقم الطلب" */
  label: string;
  /** Value extractor. Return a string, number, or a JSX-safe value. */
  accessor: (row: T) => string | number;
  /** Optional alignment: defaults to "right" (RTL). */
  align?: "right" | "left" | "center";
  /** Optional CSS class for the cell — useful for numeric columns. */
  className?: string;
}

export interface TablePdfOptions<T> {
  /** Arabic title shown at the top of the report. */
  title: string;
  /** Subtitle line under the title (e.g. date range). */
  subtitle?: string;
  /** Column definitions. Order is the order they appear. */
  columns: TablePdfColumn<T>[];
  /** The data rows. */
  rows: T[];
  /** Optional summary line at the bottom (e.g. "إجمالي: 12,500 ج.م"). */
  footer?: string;
  /** Company name shown in the header. Defaults to اسم المحل from الإعدادات. */
  companyName?: string;
}

/**
 * Generic table → PDF generator. Used by the routes that don't have a
 * dedicated generator (wholesale, inventory, purchasing, returns). The
 * shape mirrors the existing financial / courier / orders generators:
 * build RTL Arabic HTML, then `printReport` renders and prints it in place.
 * The print dialog offers "Save as PDF" as a destination.
 */
export function printTableAsPdf<T>(opts: TablePdfOptions<T>): void {
  const company = opts.companyName ?? storeIdentity().name;
  const contact = storeContactLine();
  const reportDate = format(new Date(), "dd/MM/yyyy HH:mm");
  const thead = opts.columns
    .map((c) => {
      const align = c.align === "left" ? "left" : c.align === "center" ? "center" : "right";
      return `<th style="text-align:${align}">${escapeHtml(c.label)}</th>`;
    })
    .join("");
  const tbody = opts.rows
    .map((row) => {
      const cells = opts.columns
        .map((c) => {
          const value = String(c.accessor(row) ?? "");
          const align = c.align === "left" ? "left" : c.align === "center" ? "center" : "right";
          return `<td style="text-align:${align}" class="${escapeHtml(c.className ?? "")}">${escapeHtml(value)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(opts.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4 landscape; margin: 1.5cm; }
  body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; padding: 1.5rem; color: #1e293b; }
  .header { border-bottom: 3px solid #3b82f6; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .logo { font-size: 22px; font-weight: bold; color: #1e40af; }
  .subtitle { font-size: 13px; color: #64748b; margin-top: 0.25rem; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 0.5rem 0.6rem; border-bottom: 1px solid #e2e8f0; }
  th { background: #f8fafc; font-weight: bold; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  .footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 2px solid #cbd5e1;
            font-size: 13px; font-weight: bold; color: #1e40af; text-align: center; }
  .empty { padding: 2rem; text-align: center; color: #64748b; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">${escapeHtml(company)}</div>
    ${contact ? `<div class="subtitle">${contact}</div>` : ""}
    <div>${escapeHtml(opts.title)}${opts.subtitle ? ` — ${escapeHtml(opts.subtitle)}` : ""}</div>
    <div class="subtitle">تاريخ التقرير: ${reportDate} — عدد السجلات: ${opts.rows.length}</div>
  </div>
  ${
    opts.rows.length === 0
      ? `<div class="empty">لا توجد سجلات لعرضها</div>`
      : `<table>
    <thead><tr>${thead}</tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
  }
  ${opts.footer ? `<div class="footer">${escapeHtml(opts.footer)}</div>` : ""}
  <div style="margin-top:1rem; text-align:center; font-size:11px; color:#94a3b8;">
    ${escapeHtml(company)} — جميع الحقوق محفوظة ${new Date().getFullYear()}
  </div>
</body>
</html>`;
  printReport(html, opts.title);
}

/** Minimal HTML escape to keep user-supplied data out of the report's
 * markup. Covers the three characters that would otherwise break the
 * table. Good enough for numeric / short-text columns. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function generateFinancialPdf(data: PDFReportData) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>تقرير مالي - ${data.companyName}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 2cm; }
    body { font-family: 'Cairo', sans-serif; margin: 0; padding: 0; direction: rtl; }
    .container { max-width: 21cm; margin: 0 auto; padding: 2rem; }
    .header { border-bottom: 3px solid #3b82f6; padding-bottom: 1rem; margin-bottom: 2rem; }
    .logo { font-size: 28px; font-weight: bold; color: #1e40af; }
    .report-info { font-size: 14px; color: #64748b; }
    .section { margin-bottom: 2rem; }
    .section-title { font-size: 18px; font-weight: bold; color: #1e293b; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e2e8f0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    th, td { padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0; }
    th { background-color: #f8fafc; font-weight: bold; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
    .summary-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; text-align: center; }
    .summary-label { font-size: 12px; color: #64748b; margin-bottom: 0.5rem; }
    .summary-value { font-size: 20px; font-weight: bold; }
    .positive { color: #16a34a; }
    .negative { color: #dc2626; }
    .signature-section { margin-top: 3rem; padding-top: 2rem; border-top: 2px dashed #cbd5e1; }
    .signature-line { width: 200px; height: 1px; background: #94a3b8; margin: 3rem auto 1rem; }
    .signature-label { text-align: center; font-size: 14px; color: #64748b; }
    .footer { text-align: center; margin-top: 2rem; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="logo">${data.companyName}</div>
      <div class="report-info">
        تقرير مالي رسمي<br>
        تاريخ التقرير: ${format(data.reportDate, "dd/MM/yyyy HH:mm")}
      </div>
    </div>

    <!-- Financial Summary -->
    <div class="section">
      <div class="section-title">ملخص المالية</div>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-label">إجمالي المبيعات</div>
          <div class="summary-value positive">${formatMoney(data.financialSummary.totalSales)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">إجمالي المصروفات</div>
          <div class="summary-value negative">${formatMoney(data.financialSummary.totalExpenses)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">ربح الشحن</div>
          <div class="summary-value positive">${formatMoney(data.financialSummary.shippingProfit)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">صافي الربح</div>
          <div class="summary-value ${data.financialSummary.netProfit >= 0 ? "positive" : "negative"}">${formatMoney(data.financialSummary.netProfit)}</div>
        </div>
      </div>
    </div>

    <!-- Wallet Balances -->
    <div class="section">
      <div class="section-title">أرصدة الخزائن</div>
      <table>
        <thead>
          <tr>
            <th>الخزينة</th>
            <th>الرصيد</th>
          </tr>
        </thead>
        <tbody>
          ${data.walletBalances
            .map(
              (w) => `
            <tr>
              <td>${w.label}</td>
              <td class="positive">${formatMoney(w.balance)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <!-- Shareholder Distributions -->
    ${
      data.shareholderDistributions.length > 0
        ? `
    <div class="section">
      <div class="section-title">توزيع الأرباح بين المساهمين</div>
      <table>
        <thead>
          <tr>
            <th>اسم المساهم</th>
            <th>رأس المال</th>
            <th>نسبة الملكية (%)</th>
            <th>مسحوبات الفترة</th>
            <th>المستحق صافي</th>
          </tr>
        </thead>
        <tbody>
          ${data.shareholderDistributions
            .map(
              (s) => `
            <tr>
              <td>${s.name}</td>
              <td>${formatMoney(s.capitalContributed)}</td>
              <td>${s.sharePercentage}%</td>
              <td>${formatMoney(s.drawsTaken)}</td>
              <td class="positive">${formatMoney(s.currentShare)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    <!-- Expenses Detail -->
    ${
      data.expenses.length > 0
        ? `
    <div class="section">
      <div class="section-title">سجل المصروفات الأخير</div>
      <table>
        <thead>
          <tr>
            <th>التاريخ</th>
            <th>الفئة</th>
            <th>المبلغ</th>
            <th>البيان</th>
          </tr>
        </thead>
        <tbody>
          ${data.expenses
            .slice(0, 20)
            .map(
              (e) => `
            <tr>
              <td>${format(new Date(e.date), "dd/MM/yyyy")}</td>
              <td>${e.category}</td>
              <td class="negative">${formatMoney(e.amount)}</td>
              <td>${e.description || "-"}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    <!-- Signature Section -->
    <div class="signature-section">
      <div class="signature-line"></div>
      <div class="signature-label">توقيع المدير المالي</div>
      <p class="text-center text-sm text-muted-foreground mt-2">
        تم إنشاء هذا التقرير إلكترونياً بواسطة نظام حلقة واحدة المالي
      </p>
    </div>

    <div class="footer">
      © ${new Date().getFullYear()} ${data.companyName} - جميع الحقوق محفوظة
    </div>
  </div>
</body>
</html>
  `;

  // Renders in place and opens the print dialog — "Save as PDF" is a
  // destination there, so no popup window is involved.
  printReport(htmlContent, `تقرير مالي - ${data.companyName}`);
}

// ─── Courier Financial Report ─────────────────────────────────────────────────

interface CourierReportData {
  companyName: string;
  reportDate: Date;
  accounts: Array<{
    name: string;
    phone?: string;
    totalExpectedCod: number;
    cashReceived: number;
    commissionFees: number;
    remainingBalance: number;
    orderIds: string[];
    settlements: Array<{ amount: number; note?: string; createdAt: Date }>;
  }>;
  totals: {
    expectedCod: number;
    cashReceived: number;
    fees: number;
    remaining: number;
  };
}

export function generateCourierPdf(data: CourierReportData) {
  const rows = data.accounts.map((a) => `
    <tr>
      <td>${a.name}</td>
      <td>${a.phone || "-"}</td>
      <td>${formatMoney(a.totalExpectedCod)}</td>
      <td>${formatMoney(a.cashReceived)}</td>
      <td>${formatMoney(a.commissionFees)}</td>
      <td>${formatMoney(a.remainingBalance)}</td>
      <td>${a.orderIds.length}</td>
    </tr>
  `).join("");

  const settlementRows = data.accounts.flatMap((a) =>
    a.settlements.map((s) => `
      <tr>
        <td>${a.name}</td>
        <td>${formatMoney(s.amount)}</td>
        <td>${s.note || "-"}</td>
        <td>${format(new Date(s.createdAt), "dd/MM/yyyy HH:mm")}</td>
      </tr>
    `)
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8">
<title>تقرير حسابات الشحن</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
@page { size: A4; margin: 2cm; }
body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; padding: 2rem; }
.header { border-bottom: 3px solid #3b82f6; padding-bottom: 1rem; margin-bottom: 2rem; }
.logo { font-size: 24px; font-weight: bold; color: #1e40af; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.75rem; text-align: right; border-bottom: 1px solid #e2e8f0; }
th { background: #f8fafc; font-weight: bold; }
.summary { display: grid; grid-template-columns: repeat(4,1fr); gap: 1rem; margin-bottom: 2rem; }
.card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; text-align: center; }
.card-label { font-size: 12px; color: #64748b; }
.card-value { font-size: 20px; font-weight: bold; }
.positive { color: #16a34a; }
.negative { color: #dc2626; }
.footer { text-align: center; margin-top: 2rem; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">${data.companyName}</div>
  <div>تقرير حسابات شركة الشحن — ${format(data.reportDate, "dd/MM/yyyy HH:mm")}</div>
</div>

<div class="summary">
  <div class="card"><div class="card-label">COD المتوقع</div><div class="card-value">${formatMoney(data.totals.expectedCod)}</div></div>
  <div class="card"><div class="card-label">تم التحصيل</div><div class="card-value positive">${formatMoney(data.totals.cashReceived)}</div></div>
  <div class="card"><div class="card-label">العمولات</div><div class="card-value negative">${formatMoney(data.totals.fees)}</div></div>
  <div class="card"><div class="card-label">صافي المستحق</div><div class="card-value negative">${formatMoney(data.totals.remaining)}</div></div>
</div>

<h3>ملخص الحسابات</h3>
<table>
  <thead><tr><th>شركة الشحن</th><th>الهاتف</th><th>COD المتوقع</th><th>المحصصل</th><th>العمولة</th><th>المستحق</th><th>الطلبات</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

${settlementRows ? `<h3>سجل التسويات</h3>
<table><thead><tr><th>شركة الشحن</th><th>المبلغ</th><th>ملاحظة</th><th>التاريخ</th></tr></thead>
<tbody>${settlementRows}</tbody></table>` : ""}

<div class="footer">نظام حلقة واحدة المالي — جميع الحقوق محفوظة ${new Date().getFullYear()}</div>
</body></html>`;

  printReport(html, "تقرير حسابات الشحن");
}

// ─── Orders Financial Report ─────────────────────────────────────────────────

interface OrdersReportData {
  companyName: string;
  reportDate: Date;
  orders: Array<{
    orderNumber: string;
    customerName: string;
    governorate: string;
    totalAmount: number;
    courierFee: number;
    expectedCod: number;
    status: string;
    createdAt: Date;
  }>;
  totals: { orders: number; revenue: number; cod: number; fees: number };
}

export function generateOrdersPdf(data: OrdersReportData) {
  const rows = data.orders.map((o) => `
    <tr>
      <td>${o.orderNumber}</td>
      <td>${o.customerName}</td>
      <td>${o.governorate}</td>
      <td>${formatMoney(o.totalAmount)}</td>
      <td>${formatMoney(o.courierFee)}</td>
      <td>${formatMoney(o.expectedCod)}</td>
      <td>${o.status}</td>
      <td>${format(new Date(o.createdAt), "dd/MM/yyyy")}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8">
<title>تقرير الطلبات</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
@page { size: A4 landscape; margin: 1.5cm; }
body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; padding: 1.5rem; }
.header { border-bottom: 3px solid #3b82f6; padding-bottom: 1rem; margin-bottom: 1.5rem; }
.logo { font-size: 22px; font-weight: bold; color: #1e40af; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.6rem; text-align: right; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
th { background: #f8fafc; font-weight: bold; }
.summary { display: grid; grid-template-columns: repeat(4,1fr); gap: 1rem; margin-bottom: 1.5rem; }
.card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; text-align: center; }
.card-label { font-size: 11px; color: #64748b; }
.card-value { font-size: 18px; font-weight: bold; }
.footer { text-align: center; margin-top: 1.5rem; font-size: 11px; color: #94a3b8; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">${data.companyName}</div>
  <div>تقرير الطلبات — ${format(data.reportDate, "dd/MM/yyyy HH:mm")}</div>
</div>

<div class="summary">
  <div class="card"><div class="card-label">عدد الطلبات</div><div class="card-value">${data.totals.orders}</div></div>
  <div class="card"><div class="card-label">إجمالي الإيراد</div><div class="card-value">${formatMoney(data.totals.revenue)}</div></div>
  <div class="card"><div class="card-label">COD المستحق</div><div class="card-value">${formatMoney(data.totals.cod)}</div></div>
  <div class="card"><div class="card-label">إجمالي العمولات</div><div class="card-value">${formatMoney(data.totals.fees)}</div></div>
</div>

<table>
  <thead><tr><th>رقم الطلب</th><th>العميل</th><th>المحافظة</th><th>الإجمالي</th><th>العمولة</th><th>COD</th><th>الحالة</th><th>التاريخ</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">نظام حلقة واحدة المالي — جميع الحقوق محفوظة ${new Date().getFullYear()}</div>
</body></html>`;

  printReport(html, "تقرير الطلبات");
}


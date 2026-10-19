import { useEffect, useState } from "react";
import { ChevronDown, Clock3, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import type { CashierShiftModel } from "@/hooks/useCashierShift";
import { shiftMoneyInput } from "@/lib/cashierShift";
import { WALLET_LABELS, type WalletType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `${(n / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
const states: Record<string, string> = {
  open: "مفتوحة",
  awaiting_review: "فرق نقدية ينتظر مراجعة المدير",
  awaiting_handover: "العدّ محفوظ — لم يتم التسليم بعد",
  handover_reported: "التسليم مُبلّغ — ينتظر استلام المدير",
  closed: "مغلقة — استلم المدير النقدية",
};
const actions: Record<string, string> = {
  configure: "تحديد سياسة العهدة",
  open: "فتح الوردية واستلام العهدة",
  close: "تسجيل العدّ وإغلاق البيع",
  review_discrepancy: "توثيق فرق النقدية",
  reopen: "إعادة الفتح للعدّ",
  report_handover: "تأكيد الكاشير للتسليم",
  confirm_handover: "تأكيد المدير للاستلام",
  attach_movement: "تخصيص حركة مسجلة للدرج",
  pos_payment: "دفعة فاتورة",
  admin_pos_override: "تدخل مدير في فاتورة",
};

function ShiftMetric({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        (emphasis ? "shift-metric shift-metric-primary" : "shift-metric") +
        (value.length > 18 ? " shift-metric-long" : "")
      }
    >
      <dt>{label}</dt>
      <dd>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

function ShiftReference({ value }: { value: string | number }) {
  return (
    <details className="shift-reference">
      <summary>المرجع الكامل</summary>
      <code dir="ltr">{value}</code>
    </details>
  );
}

export function CashierShiftPanel({ model: m }: { model: CashierShiftModel }) {
  const { data, loading, busy, error } = m,
    s = data?.shift,
    admin = !!data?.admin;
  const [cashier, setCashier] = useState(""),
    [opening, setOpening] = useState("500"),
    [keep, setKeep] = useState("500");
  const [actual, setActual] = useState(""),
    [reason, setReason] = useState(""),
    [eventId, setEventId] = useState("");
  const [receivedFloat, setReceivedFloat] = useState(false),
    [countConfirmed, setCountConfirmed] = useState(false);
  const [adjustmentConfirmed, setAdjustmentConfirmed] = useState(false);
  const [handed, setHanded] = useState(false),
    [received, setReceived] = useState(false),
    [inputError, setInputError] = useState("");
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    setCashier(data?.policy?.cashier_id ?? "");
    setOpening(String((data?.policy?.opening_piastre ?? 50000) / 100));
    setKeep(String((data?.policy?.keep_piastre ?? 50000) / 100));
    setReceivedFloat(false);
    setAdjustmentConfirmed(false);
  }, [data?.policy?.revision, data?.policy?.cashier_id]);
  useEffect(() => {
    setActual("");
    setReason("");
    setEventId("");
    setCountConfirmed(false);
    setHanded(false);
    setReceived(false);
    setReceivedFloat(false);
    setAdjustmentConfirmed(false);
    setExpanded(s?.status !== "open");
  }, [s?.id, s?.status]);
  useEffect(() => {
    setActual("");
    setCountConfirmed(false);
    setHanded(false);
    setReceived(false);
  }, [s?.revision]);
  useEffect(() => {
    if (error) {
      setCountConfirmed(false);
      setHanded(false);
      setReceived(false);
      setReceivedFloat(false);
      setAdjustmentConfirmed(false);
    }
  }, [error]);
  if (!m.eligible) return null;
  const execute = (action: string, input: Record<string, unknown> = {}) => {
    setInputError("");
    void m.execute(action, {
      ...(action === "open" || action === "configure"
        ? { expectedPolicyRevision: data?.policy?.revision ?? 0 }
        : { expectedRevision: s?.revision }),
      ...input,
    });
  };
  const configure = (enabled: boolean) => {
    try {
      setInputError("");
      execute("configure", {
        cashierId: cashier,
        openingPiastres: shiftMoneyInput(opening),
        keepPiastres: shiftMoneyInput(keep),
        enabled,
      });
    } catch (e) {
      setInputError((e as Error).message);
    }
  };
  let counted: number | null = null;
  try {
    if (actual) counted = shiftMoneyInput(actual);
  } catch {
    /* show validation at submit, never round malformed cash */
  }
  const previewVariance = counted == null || !s ? null : counted - s.live_expected_piastre;
  const close = () => {
    try {
      execute("close", {
        shiftId: s!.id,
        actualPiastres: shiftMoneyInput(actual),
        countConfirmed,
        reason,
      });
    } catch (e) {
      setInputError((e as Error).message);
    }
  };
  const active = !!s && s.status !== "closed";
  const floatAdjustment = data?.policy?.has_previous_shift
    ? data.policy.opening_piastre - (data.policy.previous_retained_piastre ?? 0)
    : 0;
  return (
    <section
      className="cashier-shift-panel"
      aria-label="وردية الكاشير"
      aria-busy={busy || loading}
      dir="rtl"
    >
      <header className="shift-header">
        <div className="shift-heading">
          <span className="shift-heading-icon" aria-hidden="true">
            <WalletCards />
          </span>
          <div>
            <p className="shift-eyebrow">العهدة والإقفال</p>
            <h2>وردية الكاشير — ٨ ساعات</h2>
          </div>
        </div>
        <Button
          variant="outline"
          className="shift-refresh"
          disabled={busy || loading}
          onClick={() => void m.refresh()}
        >
          <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />
          <span className="shift-refresh-label">تحديث الوردية</span>
        </Button>
      </header>
      {data?.enabled && s && (
        <div className="shift-status-row">
          <span className={"shift-status shift-status-" + s.status}>
            <span aria-hidden="true" />
            {states[s.status]}
          </span>
          <bdi className="shift-day">{s.shift_day}</bdi>
        </div>
      )}
      {data?.enabled && s && (
        <div className="shift-timing">
          <span>
            <Clock3 aria-hidden="true" />
            بدأت:{" "}
            <time dateTime={s.opened_at}>{new Date(s.opened_at).toLocaleString("ar-EG")}</time>
          </span>
          <span>
            موعد المراجعة:{" "}
            <time dateTime={s.planned_end_at}>
              {new Date(s.planned_end_at).toLocaleString("ar-EG")}
            </time>
          </span>
        </div>
      )}
      {s?.status === "open" && Date.now() > Date.parse(s.planned_end_at) && (
        <p role="status" className="shift-note shift-warning">
          انتهت الثماني ساعات؛ أكمل العملية الجارية ثم راجع الإغلاق. لا يوجد إغلاق تلقائي.
        </p>
      )}
      {loading && (
        <div role="status" className="shift-loading">
          <span className="shift-loading-mark" aria-hidden="true" />
          جارٍ التحقق من الوردية…
        </div>
      )}
      {(error || inputError) && (
        <div role="alert" className="shift-error">
          <p>{inputError || error}</p>
          {error && (
            <Button variant="outline" disabled={busy} onClick={() => void m.resolve()}>
              تأكيد نتيجة المحاولة السابقة
            </Button>
          )}
        </div>
      )}
      {data?.enabled && s && (
        <dl className="shift-summary" role="group" aria-label="ملخص نقدية الوردية">
          <ShiftMetric
            label="النقدية المتوقعة"
            value={money(s.expected_piastre ?? s.live_expected_piastre)}
            emphasis
          />
          <ShiftMetric label="عهدة البداية" value={money(s.opening_piastre)} />
          {s.actual_piastre != null && (
            <ShiftMetric label="النقدية المعدودة" value={money(s.actual_piastre)} />
          )}
          {s.variance_piastre != null && (
            <ShiftMetric label="الزيادة / العجز" value={money(s.variance_piastre)} />
          )}
        </dl>
      )}
      {admin && (
        <details className="shift-disclosure shift-policy">
          <summary className="cursor-pointer font-medium">سياسة العهدة — للمدير فقط</summary>
          <fieldset disabled={busy || active || loading} className="shift-policy-fields">
            <label>
              الكاشير المخصص
              <select
                className="w-full border rounded p-2 bg-background"
                value={cashier}
                onChange={(e) => setCashier(e.target.value)}
              >
                <option value="">اختر الكاشير الموجود</option>
                {data?.cashiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              عهدة بداية الوردية (جنيه)
              <Input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
            <label>
              المبلغ الذي يبقى للوردية التالية (جنيه)
              <Input inputMode="decimal" value={keep} onChange={(e) => setKeep(e.target.value)} />
            </label>
            <Button disabled={!cashier} onClick={() => configure(true)}>
              حفظ وتفعيل سياسة العهدة
            </Button>
            {data?.enabled && (
              <Button variant="outline" onClick={() => configure(false)}>
                إيقاف السياسة بعد اكتمال التسليم
              </Button>
            )}
          </fieldset>
          {active && (
            <p className="text-sm">تُعدّل السياسة بعد استلام المدير وإغلاق الوردية الحالية.</p>
          )}
        </details>
      )}
      {s?.status === "open" && (
        <div className="shift-expand-row">
          <Button
            variant="outline"
            aria-expanded={expanded}
            aria-controls="cashier-shift-details"
            onClick={() => setExpanded(!expanded)}
          >
            تفاصيل الوردية والإقفال
            <ChevronDown
              aria-hidden="true"
              className={expanded ? "shift-chevron shift-chevron-open" : "shift-chevron"}
            />
          </Button>
          {admin && !m.overrideReason.trim() && (
            <p className="shift-caption">تدخل المدير في البيع يتطلب سببًا من تفاصيل الوردية.</p>
          )}
        </div>
      )}
      <div id="cashier-shift-details" hidden={!expanded} className="shift-details-body">
        {data && !data.enabled && (
          <div className="shift-empty">
            <ShieldCheck aria-hidden="true" />
            <p>سياسة الوردية غير مفعلة؛ يحدد المدير العهدة والكاشير أولًا.</p>
          </div>
        )}
        {data?.enabled && (
          <>
            {data.policy && (
              <div className="shift-policy-summary">
                <span>
                  عهدة البداية المخصصة:{" "}
                  <strong>
                    <bdi>{money(data.policy.opening_piastre)}</bdi>
                  </strong>
                </span>
                <span>
                  السياسة التالية: <bdi>{money(data.policy.keep_piastre)}</bdi>
                </span>
              </div>
            )}
            {(!s || s.status === "closed") && (
              <details className="shift-disclosure shift-receive" open={!s}>
                <summary>استلام عهدة الوردية</summary>
                <div className="shift-action-card">
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={receivedFloat}
                      onChange={(e) => setReceivedFloat(e.target.checked)}
                    />
                    عدَدت واستلمت العهدة المخصصة فعليًا، بما فيها المبلغ المتبقي من الوردية السابقة
                  </label>
                  {admin && (
                    <label>
                      سبب فتح المدير نيابة عن الكاشير
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={500}
                      />
                    </label>
                  )}
                  {floatAdjustment !== 0 && (
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={adjustmentConfirmed}
                        onChange={(e) => setAdjustmentConfirmed(e.target.checked)}
                      />
                      {floatAdjustment > 0
                        ? `استلمت زيادة العهدة ${money(floatAdjustment)} من الخزنة فعليًا`
                        : `سلّمت فرق تخفيض العهدة ${money(-floatAdjustment)} إلى الخزنة فعليًا`}
                    </label>
                  )}
                  <Button
                    className="shift-primary-action"
                    disabled={
                      busy ||
                      loading ||
                      !receivedFloat ||
                      !data.policy ||
                      (floatAdjustment !== 0 && !adjustmentConfirmed) ||
                      (admin && reason.trim().length < 4)
                    }
                    onClick={() =>
                      execute("open", {
                        floatReceived: receivedFloat,
                        reason,
                        ...(floatAdjustment !== 0
                          ? { floatAdjustmentConfirmed: adjustmentConfirmed }
                          : {}),
                      })
                    }
                  >
                    استلام العهدة وفتح الوردية
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    وردية واحدة يوميًا؛ إذا أغلقتها اليوم فلن يُفتح سجل ثانٍ.
                  </p>
                </div>
              </details>
            )}
            {s && (
              <div className="shift-workspace">
                <div className="shift-actions">
                  {s.status === "open" && (
                    <fieldset disabled={busy || loading} className="shift-action-card">
                      {admin && (
                        <label>
                          سبب تدخل المدير في مبيعات أو مرتجعات هذه الوردية
                          <Input
                            value={m.overrideReason}
                            onChange={(e) => m.setOverrideReason(e.target.value)}
                            maxLength={500}
                          />
                        </label>
                      )}
                      {admin && (
                        <details className="shift-disclosure shift-allocation">
                          <summary>تخصيص مصروف أو حركة نقدية مسجلة للدرج</summary>
                          <p className="text-xs">
                            اختر حركة خرجت أو دخلت هذا الدرج فعلًا. لا تُنشأ حركة مالية جديدة هنا.
                            الكاشير لا يملك صلاحية تسجيل المصروفات.
                          </p>
                          <label>
                            الحركة المسجلة
                            <select
                              className="w-full border rounded p-2 bg-background"
                              value={eventId}
                              onChange={(e) => setEventId(e.target.value)}
                            >
                              <option value="">اختر حركة نقدية</option>
                              {data.allocatable?.map((x) => (
                                <option key={x.event_id} value={x.event_id}>
                                  {x.description} — {money(x.amount_piastre)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            سبب تخصيص الحركة للدرج
                            <Input
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              maxLength={500}
                            />
                          </label>
                          <Button
                            className="shift-primary-action"
                            disabled={!eventId || reason.trim().length < 4}
                            onClick={() =>
                              execute("attach_movement", { shiftId: s.id, eventId, reason })
                            }
                          >
                            تأكيد تخصيص الحركة
                          </Button>
                        </details>
                      )}
                      <label>
                        النقدية الفعلية الموجودة (جنيه)
                        <Input
                          inputMode="decimal"
                          value={actual}
                          onChange={(e) => setActual(e.target.value)}
                        />
                      </label>
                      {previewVariance != null && previewVariance !== 0 && (
                        <p role="alert" className="text-destructive">
                          فرق النقدية: {money(previewVariance)} — يتطلب توثيق ومراجعة المدير، ولن
                          تُعدّل الأرصدة تلقائيًا.
                        </p>
                      )}
                      {counted != null && (
                        <p>
                          يبقى: {money(Math.min(s.keep_piastre, counted))} — يُسلّم للخزنة:{" "}
                          {money(counted - Math.min(s.keep_piastre, counted))}
                        </p>
                      )}
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={countConfirmed}
                          onChange={(e) => setCountConfirmed(e.target.checked)}
                        />
                        عدَدت النقدية فعليًا وأوقفت معاملات هذه الوردية
                      </label>
                      {admin && (
                        <label>
                          سبب إغلاق المدير نيابة عن الكاشير
                          <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            maxLength={500}
                          />
                        </label>
                      )}
                      <Button
                        className="shift-primary-action"
                        disabled={
                          !countConfirmed || counted == null || (admin && reason.trim().length < 4)
                        }
                        onClick={close}
                      >
                        إغلاق الوردية وحفظ العدّ
                      </Button>
                    </fieldset>
                  )}
                  {s.status === "awaiting_review" && (
                    <div role="alert" className="shift-action-card shift-warning">
                      <p>
                        يوجد فرق نقدية؛ التسليم متوقف حتى مراجعة المدير. لم يُنشأ مصروف ولم يُصحح
                        الرصيد.
                      </p>
                      {admin && (
                        <>
                          <label>
                            توثيق سبب الفرق وخطة معالجته
                            <Input
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              maxLength={500}
                            />
                          </label>
                          <Button
                            className="shift-primary-action"
                            disabled={busy || reason.trim().length < 4}
                            onClick={() => execute("review_discrepancy", { shiftId: s.id, reason })}
                          >
                            اعتماد الإقفال مع توثيق الفرق
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {admin && ["awaiting_review", "awaiting_handover"].includes(s.status) && (
                    <div className="shift-action-card shift-recount">
                      <label>
                        سبب إعادة العدّ
                        <Input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={500}
                        />
                      </label>
                      <Button
                        className="shift-primary-action"
                        variant="outline"
                        disabled={busy || reason.trim().length < 4}
                        onClick={() => execute("reopen", { shiftId: s.id, reason })}
                      >
                        إعادة فتح الوردية للعدّ
                      </Button>
                    </div>
                  )}
                  {s.status === "awaiting_handover" && (
                    <div className="space-y-2">
                      <p>
                        لم تسلّم النقدية بعد. المطلوب: {money(s.handover_piastre)}، ويبقى بالدرج{" "}
                        {money(s.retained_piastre)}.
                      </p>
                      <label>
                        <input
                          type="checkbox"
                          checked={handed}
                          onChange={(e) => setHanded(e.target.checked)}
                        />
                        سلّمت المبلغ فعليًا للمدير / الخزنة
                      </label>
                      {admin && (
                        <label>
                          سبب تأكيد المدير للتسليم بدل الكاشير
                          <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            maxLength={500}
                          />
                        </label>
                      )}
                      <Button
                        className="shift-primary-action"
                        disabled={busy || !handed || (admin && reason.trim().length < 4)}
                        onClick={() =>
                          execute("report_handover", {
                            shiftId: s.id,
                            physicalHandoverConfirmed: handed,
                            ...(admin ? { reason } : {}),
                          })
                        }
                      >
                        تأكيد التسليم الفعلي
                      </Button>
                    </div>
                  )}
                  {s.status === "handover_reported" && (
                    <div className="shift-action-card">
                      <p>أبلغ الكاشير التسليم؛ لا يُعد الاستلام مكتملًا حتى يؤكده المدير.</p>
                      {admin && (
                        <>
                          <label>
                            <input
                              type="checkbox"
                              checked={received}
                              onChange={(e) => setReceived(e.target.checked)}
                            />
                            استلمت {money(s.handover_piastre)} فعليًا وتحققت من العهدة المتبقية
                          </label>
                          <Button
                            className="shift-primary-action"
                            disabled={busy || !received}
                            onClick={() =>
                              execute("confirm_handover", {
                                shiftId: s.id,
                                cashReceivedConfirmed: received,
                              })
                            }
                          >
                            تأكيد الاستلام واعتماد الإغلاق
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {!!s.variance_piastre && (
                    <p role="status" className="shift-note shift-warning">
                      فرق موثق: <bdi>{money(s.variance_piastre)}</bdi>. {s.discrepancy_reason} —
                      توثيق الفرق ليس تسوية مالية أو خصم راتب.
                    </p>
                  )}
                </div>
                <div className="shift-accounting">
                  <dl className="shift-handover-summary" aria-label="العهدة المتبقية والتسليم">
                    <ShiftMetric
                      label="المبلغ الذي يبقى للوردية التالية"
                      value={money(s.retained_piastre ?? s.keep_piastre)}
                    />
                    {s.handover_piastre != null && (
                      <ShiftMetric
                        label="المبلغ المطلوب تسليمه للخزنة"
                        value={money(s.handover_piastre)}
                      />
                    )}
                  </dl>
                  <details className="shift-disclosure">
                    <summary>التفاصيل المحاسبية</summary>
                    <h3 className="shift-section-label">تفاصيل الحركات النقدية</h3>
                    <dl className="shift-breakdown">
                      <ShiftMetric label="المبيعات النقدية" value={money(s.cash_sales_piastre)} />
                      <ShiftMetric
                        label="المرتجعات النقدية"
                        value={money(s.cash_refunds_piastre)}
                      />
                      <ShiftMetric
                        label="المصروفات النقدية المخصصة للدرج"
                        value={money(s.cash_expenses_piastre)}
                      />
                      <ShiftMetric
                        label="الحركات النقدية الأخرى"
                        value={money(s.other_cash_piastre)}
                      />
                    </dl>
                    <h3 className="shift-section-label shift-electronic-heading">
                      المدفوعات الإلكترونية
                    </h3>
                    <p className="shift-caption">
                      المدفوعات الإلكترونية تخص فواتير هذه الوردية فقط، ولا تدخل عدّ الدرج:
                    </p>
                    <ul className="shift-records">
                      {s.electronic.map((x) => (
                        <li className="shift-payment" key={x.wallet_id}>
                          <span>{WALLET_LABELS[x.wallet_id as WalletType] ?? x.wallet_id}</span>
                          <strong>
                            <bdi>{money(x.amount_piastre)}</bdi>
                          </strong>
                        </li>
                      ))}
                    </ul>
                    {!s.electronic.length && (
                      <p className="shift-caption">لا توجد مدفوعات إلكترونية في هذه الوردية.</p>
                    )}
                  </details>
                </div>
              </div>
            )}
          </>
        )}
        {((data?.enabled && s) || !!data?.history.length || !!data?.audit.length) && (
          <details className="shift-disclosure shift-history-group">
            <summary>الحركات والسجلات</summary>
            {data?.enabled && s && (
              <details className="shift-disclosure shift-history">
                <summary>
                  آخر ٢٠٠ حركة من هذه الوردية
                  <span className="shift-count">{s.movements.length.toLocaleString("ar-EG")}</span>
                </summary>
                <ul className="shift-records">
                  {s.movements.map((x, i) => (
                    <li className="shift-record" key={x.event_id + ":" + i}>
                      <div className="shift-record-top">
                        <div>
                          <span className="shift-record-kind">
                            {{
                              sale: "بيع",
                              refund: "مرتجع",
                              expense: "مصروف",
                              other: "حركة نقدية",
                            }[x.category] ?? x.category}
                          </span>
                          <p className="shift-record-title">
                            <bdi>{x.document_number}</bdi>
                          </p>
                        </div>
                        <strong className="shift-record-amount">
                          <bdi>{money(x.payment_piastre)}</bdi>
                        </strong>
                      </div>
                      <div className="shift-record-meta">
                        <span>{WALLET_LABELS[x.wallet_id as WalletType] ?? x.wallet_id}</span>
                        <time dateTime={x.recorded_at}>
                          {new Date(x.recorded_at).toLocaleString("ar-EG")}
                        </time>
                      </div>
                      <ShiftReference value={x.event_id} />
                    </li>
                  ))}
                </ul>
                {!s.movements.length && (
                  <p className="shift-caption">لا توجد حركات مسجلة في هذه الوردية.</p>
                )}
              </details>
            )}
            {!!data?.history.length && (
              <details className="shift-disclosure shift-history">
                <summary>
                  آخر ١٤ ملخص وردية
                  <span className="shift-count">{data.history.length.toLocaleString("ar-EG")}</span>
                </summary>
                <ul className="shift-records">
                  {data.history.map((x) => (
                    <li className="shift-record" key={x.id}>
                      <div className="shift-record-top">
                        <bdi className="shift-record-title">{x.shift_day}</bdi>
                        <span className={"shift-status shift-status-" + x.status}>
                          {states[x.status]}
                        </span>
                      </div>
                      <dl className="shift-history-money">
                        <ShiftMetric label="المتوقع" value={money(x.expected_piastre)} />
                        <ShiftMetric label="المعدود" value={money(x.actual_piastre)} />
                        <ShiftMetric label="الفرق" value={money(x.variance_piastre)} />
                        <ShiftMetric label="التسليم" value={money(x.handover_piastre)} />
                      </dl>
                      <ShiftReference value={x.id} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!!data?.audit.length && (
              <details className="shift-disclosure shift-history">
                <summary>
                  سجل إجراءات العهدة والتسليم
                  <span className="shift-count">{data.audit.length.toLocaleString("ar-EG")}</span>
                </summary>
                <ul className="shift-records">
                  {data.audit.map((x) => (
                    <li className="shift-record shift-audit-record" key={x.id}>
                      <span className="shift-audit-dot" aria-hidden="true" />
                      <div>
                        <p className="shift-record-title">
                          {actions[x.action] ??
                            (x.action.startsWith("rejected_")
                              ? "محاولة وردية مرفوضة"
                              : "إجراء وردية")}
                        </p>
                        <time className="shift-caption" dateTime={x.recorded_at}>
                          {new Date(x.recorded_at).toLocaleString("ar-EG")}
                        </time>
                        {x.detail.input?.reason && (
                          <p className="shift-audit-reason">{x.detail.input.reason}</p>
                        )}
                        <ShiftReference value={x.id} />
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </details>
        )}
      </div>
      <details className="shift-disclosure shift-explanation">
        <summary>معلومات العهدة</summary>
        <p className="shift-caption">
          الدرج والخزنة عهدتان لنفس النقدية؛ تسليم العهدة لا ينشئ إيرادًا أو مصروفًا. مدة الثماني
          ساعات تذكير فقط.
        </p>
      </details>
    </section>
  );
}

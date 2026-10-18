import { useEffect, useState } from "react";
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
  const [handed, setHanded] = useState(false),
    [received, setReceived] = useState(false),
    [inputError, setInputError] = useState("");
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    setCashier(data?.policy?.cashier_id ?? "");
    setOpening(String((data?.policy?.opening_piastre ?? 50000) / 100));
    setKeep(String((data?.policy?.keep_piastre ?? 50000) / 100));
  }, [data?.policy?.updated_at, data?.policy?.cashier_id]);
  useEffect(() => {
    setActual("");
    setReason("");
    setEventId("");
    setCountConfirmed(false);
    setHanded(false);
    setReceived(false);
    setExpanded(s?.status !== "open");
  }, [s?.id, s?.status]);
  if (!m.eligible) return null;
  const execute = (action: string, input: Record<string, unknown> = {}) => {
    setInputError("");
    void m.execute(action, input);
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
  return (
    <section
      className="rounded-2xl border border-border bg-card p-4 space-y-4"
      aria-label="وردية الكاشير"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">وردية الكاشير — ٨ ساعات</h2>
        <Button variant="outline" disabled={busy || loading} onClick={() => void m.refresh()}>
          تحديث الوردية
        </Button>
      </div>
      {s?.status === "open" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            مفتوحة — العهدة {money(s.opening_piastre)} — المتوقع بالدرج{" "}
            {money(s.live_expected_piastre)}
          </span>
          <Button
            variant="outline"
            aria-expanded={expanded}
            aria-controls="cashier-shift-details"
            onClick={() => setExpanded(!expanded)}
          >
            تفاصيل الوردية والإقفال
          </Button>
          {admin && !m.overrideReason.trim() && (
            <span>تدخل المدير في البيع يتطلب سببًا من تفاصيل الوردية.</span>
          )}
        </div>
      )}
      {s?.status === "open" && Date.now() > Date.parse(s.planned_end_at) && (
        <p role="status">
          انتهت الثماني ساعات؛ أكمل العملية الجارية ثم راجع الإغلاق. لا يوجد إغلاق تلقائي.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        الدرج والخزنة عهدتان لنفس النقدية؛ تسليم العهدة لا ينشئ إيرادًا أو مصروفًا. مدة الثماني
        ساعات تذكير فقط.
      </p>
      {loading && <p role="status">جارٍ التحقق من الوردية…</p>}
      {(error || inputError) && (
        <div role="alert" className="text-destructive">
          <p>{inputError || error}</p>
          {error && (
            <Button variant="outline" disabled={busy} onClick={() => void m.resolve()}>
              تأكيد نتيجة المحاولة السابقة
            </Button>
          )}
        </div>
      )}
      <div id="cashier-shift-details" hidden={!expanded} className="space-y-4">
        {admin && (
          <details>
            <summary className="cursor-pointer font-medium">سياسة العهدة — للمدير فقط</summary>
            <fieldset disabled={busy || active || loading} className="grid gap-3 mt-3">
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
        {data && !data.enabled && (
          <p>سياسة الوردية غير مفعلة؛ يحدد المدير العهدة والكاشير أولًا.</p>
        )}
        {data?.enabled && (
          <>
            {data.policy && (
              <p>
                عهدة البداية المخصصة: <strong>{money(data.policy.opening_piastre)}</strong> —
                السياسة التالية: {money(data.policy.keep_piastre)}
              </p>
            )}
            {(!s || s.status === "closed") && (
              <div className="space-y-2">
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
                <Button
                  disabled={
                    busy ||
                    loading ||
                    !receivedFloat ||
                    !data.policy ||
                    (admin && reason.trim().length < 4)
                  }
                  onClick={() => execute("open", { floatReceived: receivedFloat, reason })}
                >
                  استلام العهدة وفتح الوردية
                </Button>
                <p className="text-xs text-muted-foreground">
                  وردية واحدة يوميًا؛ إذا أغلقتها اليوم فلن يُفتح سجل ثانٍ.
                </p>
              </div>
            )}
            {s && (
              <div className="space-y-3">
                <p>
                  <strong>{states[s.status]}</strong> — {s.shift_day}
                </p>
                <p className="text-sm">
                  بدأت: {new Date(s.opened_at).toLocaleString("ar-EG")} — موعد المراجعة:{" "}
                  {new Date(s.planned_end_at).toLocaleString("ar-EG")}
                </p>
                {s.status === "open" && Date.now() > Date.parse(s.planned_end_at) && (
                  <p role="status">
                    انتهت الثماني ساعات؛ راجع العدّ والإغلاق عندما تنتهي العمليات الجارية. لن تُغلق
                    الوردية تلقائيًا.
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt>عهدة البداية</dt>
                  <dd>{money(s.opening_piastre)}</dd>
                  <dt>المبيعات النقدية</dt>
                  <dd>{money(s.cash_sales_piastre)}</dd>
                  <dt>المرتجعات النقدية</dt>
                  <dd>{money(s.cash_refunds_piastre)}</dd>
                  <dt>المصروفات النقدية المخصصة للدرج</dt>
                  <dd>{money(s.cash_expenses_piastre)}</dd>
                  <dt>الحركات النقدية الأخرى</dt>
                  <dd>{money(s.other_cash_piastre)}</dd>
                  <dt>النقدية المتوقعة</dt>
                  <dd>{money(s.expected_piastre ?? s.live_expected_piastre)}</dd>
                  <dt>النقدية المعدودة</dt>
                  <dd>{money(s.actual_piastre)}</dd>
                  <dt>الزيادة / العجز</dt>
                  <dd>{money(s.variance_piastre)}</dd>
                  <dt>المبلغ الذي يبقى للوردية التالية</dt>
                  <dd>{money(s.retained_piastre ?? s.keep_piastre)}</dd>
                  <dt>المبلغ المطلوب تسليمه للخزنة</dt>
                  <dd>{money(s.handover_piastre)}</dd>
                </dl>
                <p className="text-sm">
                  المدفوعات الإلكترونية تخص فواتير هذه الوردية فقط، ولا تدخل عدّ الدرج:
                </p>
                <ul>
                  {s.electronic.map((x) => (
                    <li key={x.wallet_id}>
                      {WALLET_LABELS[x.wallet_id as WalletType] ?? x.wallet_id}:{" "}
                      {money(x.amount_piastre)}
                    </li>
                  ))}
                </ul>
                {s.status === "open" && (
                  <fieldset disabled={busy || loading} className="space-y-2">
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
                      <details>
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
                  <div role="alert">
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
                  <div>
                    <label>
                      سبب إعادة العدّ
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={500}
                      />
                    </label>
                    <Button
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
                  <div>
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
                  <p role="status">
                    فرق موثق: {money(s.variance_piastre)}. {s.discrepancy_reason} — توثيق الفرق ليس
                    تسوية مالية أو خصم راتب.
                  </p>
                )}
                <details>
                  <summary>آخر ٢٠٠ حركة من هذه الوردية</summary>
                  <ul>
                    {s.movements.map((x, i) => (
                      <li key={`${x.event_id}:${i}`}>
                        {x.document_number} —{" "}
                        {WALLET_LABELS[x.wallet_id as WalletType] ?? x.wallet_id} —{" "}
                        {money(x.payment_piastre)}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </>
        )}
        {!!data?.history.length && (
          <details>
            <summary>آخر ١٤ ملخص وردية</summary>
            <ul>
              {data.history.map((x) => (
                <li key={x.id}>
                  {x.shift_day} — {states[x.status]} — المتوقع {money(x.expected_piastre)} — المعدود{" "}
                  {money(x.actual_piastre)} — الفرق {money(x.variance_piastre)} — التسليم{" "}
                  {money(x.handover_piastre)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!!data?.audit.length && (
          <details>
            <summary>سجل إجراءات العهدة والتسليم</summary>
            <ul>
              {data.audit.map((x) => (
                <li key={x.id}>
                  {new Date(x.recorded_at).toLocaleString("ar-EG")} —{" "}
                  {actions[x.action] ?? "إجراء وردية"} {x.detail.input?.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

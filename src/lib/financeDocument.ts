import { useFinancialStore } from "@/store/useFinancialStore";
import { buildExpenseLines } from "./ledger/expenses";
import type { WalletType } from "@/types";

export interface FinanceDocumentDraft {
  id: string;
  kind: "expense" | "payroll";
  date: string;
  amount: number;
  wallet: WalletType;
  category: string;
  employeeName: string;
  paymentType: "salary" | "bonus" | "advance";
  note: string;
}

/** Same document RPC and ledger builder as Desktop; cap enforcement stays in SQL. */
export async function recordFinanceDocument(draft: FinanceDocumentDraft) {
  if (!Number.isFinite(draft.amount) || draft.amount <= 0)
    throw new Error("أدخل مبلغاً صحيحاً أكبر من صفر");
  const date = new Date(draft.date);
  const common = { id: draft.id, amount: draft.amount, date, description: draft.note || undefined };
  const category = draft.kind === "payroll" ? "salaries" : draft.category;
  const event = {
    kind: draft.kind,
    occurredAt: date,
    actor: draft.kind === "payroll" ? "مرتبات" : "مصروف",
    refType: draft.kind,
    refId: draft.id,
    payload: {
      category,
      description: draft.note,
      wallet: draft.wallet,
      ...(draft.kind === "payroll"
        ? { employeeName: draft.employeeName, type: draft.paymentType }
        : {}),
    },
    lines: buildExpenseLines({ category, amount: draft.amount, wallet: draft.wallet }),
  };
  return draft.kind === "expense"
    ? useFinancialStore.getState().recordExpense({ ...common, category }, event)
    : useFinancialStore
        .getState()
        .recordPayroll(
          {
            ...common,
            employeeName: draft.employeeName,
            type: draft.paymentType,
            wallet: draft.wallet,
          },
          event,
        );
}

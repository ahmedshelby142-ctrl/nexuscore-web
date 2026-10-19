import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import {
  readCashierShift,
  actOnCashierShift,
  resolveCashierShift,
  shiftError,
  type CashierShiftSnapshot,
} from "@/lib/cashierShift";

export function useCashierShift() {
  const role = useAuthStore((s) => s.userRole),
    revision = useAuthStore((s) => s.accessRevision);
  const eligible = role === "ADMIN" || role === "CASHIER_ONLY";
  const [data, setData] = useState<CashierShiftSnapshot | null>(null),
    [loading, setLoading] = useState(eligible);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [overrideReason, setOverrideReason] = useState("");
  const serial = useRef(0),
    submitting = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!eligible) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const value = await readCashierShift();
      if (request === serial.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (request === serial.current) {
        setData(null);
        setError(shiftError(e));
      }
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [eligible, revision]);
  useEffect(() => {
    setData(null);
    setOverrideReason("");
    void refresh();
    return () => {
      serial.current++;
    };
  }, [refresh]);
  useEffect(() => {
    setOverrideReason("");
  }, [data?.shift?.id, data?.shift?.status]);
  const execute = async (action: string, input: Record<string, unknown> = {}) => {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await actOnCashierShift(action, input);
      await refresh();
      return true;
    } catch (e) {
      setError(shiftError(e));
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const resolve = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await resolveCashierShift();
      await refresh();
    } catch (e) {
      setError(shiftError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const canSell =
    !eligible ||
    (!loading &&
      !busy &&
      !error &&
      !!data &&
      (!data.enabled ||
        (data.shift?.status === "open" && (!data.admin || overrideReason.trim().length >= 4))));
  return {
    accessRevision: revision,
    eligible,
    data,
    loading,
    error,
    busy,
    overrideReason,
    setOverrideReason,
    canSell,
    refresh,
    execute,
    resolve,
  };
}
export type CashierShiftModel = ReturnType<typeof useCashierShift>;

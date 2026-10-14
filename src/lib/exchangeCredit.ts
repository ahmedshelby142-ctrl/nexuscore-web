import Decimal from "decimal.js";

/** Draft only. PostgreSQL derives and persists the authoritative allocation. */
export function exchangeCreditDraft(goods: number, shipping: number, compensation: number, cashDeposit: number, originalCredit: number) {
  const piastres = (v: number) => new Decimal(v).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const obligation = piastres(goods).plus(piastres(shipping)).plus(piastres(compensation)).minus(piastres(cashDeposit));
  const allocated = Decimal.min(Decimal.max(0, piastres(originalCredit)), Decimal.max(0, obligation));
  return { allocatedPiastres: allocated.toNumber(), excessPiastres: Decimal.max(0, piastres(originalCredit).minus(allocated)).toNumber(),
    cod: obligation.minus(allocated).div(100).toNumber() };
}

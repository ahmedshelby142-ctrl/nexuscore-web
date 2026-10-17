import {canViewStoreFinance} from "@/lib/roles";
import {useAuthStore} from "@/store/useAuthStore";

/** The server projection is the privacy boundary, including refresh readers. */
export function operationalSource(table: string): string {
 if (canViewStoreFinance(useAuthStore.getState().userRole)) return table;
 return table === "orders" ? "orders_operational"
  : table === "return_records" ? "return_records_operational" : table;
}

/** Discard a late privileged response after logout, account/role change or a
 * fresh verification cycle, even if the same role returns before it finishes. */
export function captureReadAuthority() {
 const s=useAuthStore.getState();
 return {id:s.session?.user.id,role:s.userRole,revision:s.accessRevision};
}
export function assertReadAuthority(proof: ReturnType<typeof captureReadAuthority>) {
 const current=captureReadAuthority();
 if(current.id!==proof.id||current.role!==proof.role||current.revision!==proof.revision)
  throw new Error("تغيّرت صلاحيات الجلسة أثناء القراءة؛ أعد تحميل البيانات بالحساب الحالي.");
}

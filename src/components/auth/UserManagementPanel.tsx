import { useEffect, useState } from "react";
import { useUsersStore, type StaffMember } from "@/store/useUsersStore";
import { APP_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type AppRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Users, Edit2, Trash2, ShieldCheck, Info } from "lucide-react";

/** The colour each role wears in the table. */
const ROLE_TONE: Record<AppRole, string> = {
  ADMIN: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
  POS_ECOMMERCE: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  ECOMMERCE_ONLY: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  ACCOUNTANT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

/**
 * الصلاحيات والمستخدمين — assign one of FOUR fixed roles. Nothing else.
 *
 * There is no role builder and no permission checkboxes on purpose: the four
 * roles are hardcoded in `lib/roles.ts` and enforced by RLS. A screen that let
 * an admin invent a fifth would be inventing a role the database has never
 * heard of and will not honour.
 */
export function UserManagementPanel() {
  const { staffMembers, isLoading, error, fetchStaffMembers, updateUserRole, removeUser } =
    useUsersStore();

  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [role, setRole] = useState<AppRole>("POS_ECOMMERCE");
  const [removing, setRemoving] = useState<StaffMember | null>(null);

  useEffect(() => {
    void fetchStaffMembers();
  }, [fetchStaffMembers]);

  const openEdit = (member: StaffMember) => {
    setEditing(member);
    setRole(member.role);
  };

  const saveRole = async () => {
    if (!editing) return;
    await updateUserRole(editing.userId, role);
    setEditing(null);
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await removeUser(removing.userId);
    setRemoving(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-2">
            <ShieldCheck className="size-7 text-primary" />
            المستخدمين والصلاحيات
          </h1>
          <p className="text-muted-foreground mt-1">
            أربع صلاحيات ثابتة — كل مستخدم بياخد واحدة منهم بس
          </p>
        </div>
      </div>

      {/* How a person joins. Saying this plainly beats an invite button that
          cannot actually create an account from the browser. */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-4 flex items-start gap-3">
        <Info className="size-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-900 dark:text-blue-200 space-y-1">
          <p className="font-semibold">إزاي تضيف موظف جديد؟</p>
          <p className="leading-relaxed">
            الموظف بيعمل حساب بنفسه من شاشة الدخول بالبريد الإلكتروني، وبعدين يظهر هنا وتحدد له
            الصلاحية. الصلاحية بتتطبّق على السيرفر نفسه، مش على الشاشة بس.
          </p>
        </div>
      </div>

      {/* What each role opens — so the choice below is an informed one. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {APP_ROLES.map((r) => (
          <div key={r} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs font-bold px-2 py-1 rounded-full ${ROLE_TONE[r]}`}>
                {ROLE_LABELS[r]}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</p>
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-lg p-3 bg-red-50 border border-red-200 dark:bg-red-950/20 dark:border-red-900">
          <p className="text-sm font-medium text-red-900 dark:text-red-300">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>فريق العمل</CardTitle>
          <CardDescription>المستخدمين المرتبطين بالمحل والصلاحية بتاعت كل واحد</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">الاسم</TableHead>
                <TableHead className="text-right">البريد الإلكتروني</TableHead>
                <TableHead className="text-center">الصلاحية</TableHead>
                <TableHead className="text-center">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && staffMembers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                    جاري التحميل...
                  </TableCell>
                </TableRow>
              ) : staffMembers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-10">
                    <Users className="size-10 mx-auto text-muted-foreground/50 mb-3" />
                    <p className="text-muted-foreground">
                      مفيش مستخدمين مسجلين — الموظف بيعمل حساب من شاشة الدخول وبعدين يظهر هنا.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                staffMembers.map((member) => (
                  <TableRow key={member.userId}>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell className="text-muted-foreground" dir="ltr">
                      {member.email}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge className={ROLE_TONE[member.role]} variant="secondary">
                        {ROLE_LABELS[member.role]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <Button aria-label="تعديل صلاحية المستخدم"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => openEdit(member)}
                        >
                          <Edit2 className="size-4" />
                        </Button>
                        <Button aria-label="إزالة المستخدم من المتجر"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive"
                          onClick={() => setRemoving(member)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Change a role — four options, never a free-text field */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>تعديل صلاحية {editing?.name}</DialogTitle>
            <DialogDescription>
              الصلاحية بتتطبّق على قاعدة البيانات نفسها، فالتغيير ده بيقفل ويفتح شاشات فعلياً.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APP_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditing(null)} disabled={isLoading}>
              إلغاء
            </Button>
            <Button onClick={() => void saveRole()} disabled={isLoading}>
              {isLoading ? "جاري الحفظ..." : "حفظ الصلاحية"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>إزالة {removing?.name} من المحل؟</DialogTitle>
            <DialogDescription>
              هيتشال من فريق العمل ومش هيقدر يفتح أي شاشة من شاشات المحل. الحساب نفسه مش هيتمسح.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={isLoading}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmRemove()}
              disabled={isLoading}
            >
              {isLoading ? "جاري الإزالة..." : "تأكيد الإزالة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

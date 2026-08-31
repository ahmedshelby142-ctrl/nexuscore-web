import { useState } from "react";
import { Building2, Plus, MapPin, Phone, Power, Trash2, Users, Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useBranchStore, describeRole } from "@/store/useBranchStore";
import { useAuthStore } from "@/store/useAuthStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { USER_ROLE_LABELS, type UserRole } from "@/types";

/**
 * Branches & outlets screen.
 *
 * The store layer (useBranchStore) handles:
 *   - branches[]          catalogue
 *   - currentBranchId     active scope
 *   - assignments[]       user → branch → role
 *
 * Records produced by other stores do not yet carry a branchId; the
 * scope helper in useBranchStore treats branch-less records as
 * branch-agnostic so the rest of the system continues to work.
 */
export function BranchesPage() {
  const {
    branches,
    currentBranchId,
    assignments,
    addBranch,
    removeBranch,
    toggleBranchActive,
    setCurrentBranch,
    assignUser,
    unassignUser,
  } = useBranchStore();
  const { username } = useAuthStore();

  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const [branchForm, setBranchForm] = useState({ name: "", code: "", address: "", phone: "" });
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState({ username: "", role: "cashier" as UserRole });

  const handleAddBranch = async () => {
    if (!branchForm.name || !branchForm.code) return;
    // Awaited: the dialog stays open, with the values still in it, if the
    // branch did not reach Supabase.
    try {
      await addBranch({
        name: branchForm.name,
        code: branchForm.code.toUpperCase(),
        address: branchForm.address || undefined,
        phone: branchForm.phone || undefined,
        isActive: true,
      });
      setBranchForm({ name: "", code: "", address: "", phone: "" });
      setIsBranchOpen(false);
    } catch {
      /* the store announced it; leave the form for a retry */
    }
  };

  const handleAssign = () => {
    if (!assignForm.username || !currentBranchId) return;
    assignUser({
      userId: assignForm.username.toLowerCase().replace(/\s+/g, "-"),
      username: assignForm.username,
      branchId: currentBranchId,
      role: assignForm.role,
    });
    setAssignForm({ username: "", role: "cashier" });
    setIsAssignOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-2">
            <Building2 className="size-7 text-primary" />
            الفروع والمنافذ
          </h1>
          <p className="text-muted-foreground mt-1">إدارة فروع المحل وتعيين المستخدمين لكل فرع</p>
        </div>
        <Button onClick={() => setIsBranchOpen(true)}>
          <Plus className="size-4 ml-2" /> إضافة فرع
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right px-4">الاسم</TableHead>
              <TableHead className="text-center px-4">الكود</TableHead>
              <TableHead className="text-right px-4">العنوان</TableHead>
              <TableHead className="text-right px-4">الهاتف</TableHead>
              <TableHead className="text-center px-4">الحالة</TableHead>
              <TableHead className="text-center px-4">إجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
              {branches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12">
                    <EmptyState
                      icon={Building2}
                      title="لا توجد فروع مسجلة"
                      description="أضف فرعك الأول للبدء في إدارة المخزون والمبيعات."
                    />
                  </TableCell>
                </TableRow>
            ) : (
              branches.map((b) => (
                <TableRow key={b.id} className={currentBranchId === b.id ? "bg-primary/5" : ""}>
                  <TableCell className="font-medium px-4">{b.name}</TableCell>
                  <TableCell className="text-center px-4 font-mono text-xs">{b.code}</TableCell>
                  <TableCell className="text-sm px-4 text-muted-foreground">
                    {b.address ? (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3" /> {b.address}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm px-4 text-muted-foreground">
                    {b.phone ? (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="size-3" /> {b.phone}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-center px-4">
                    {b.isActive ? (
                      <Badge variant="default">نشط</Badge>
                    ) : (
                      <Badge variant="secondary">معطل</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center px-4">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant={currentBranchId === b.id ? "default" : "ghost"}
                        size="sm"
                        onClick={() => setCurrentBranch(currentBranchId === b.id ? null : b.id)}
                        title="تفعيل كنطاق العمل الحالي"
                      >
                        {currentBranchId === b.id ? "النطاق الحالي" : "تعيين كنطاق"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => toggleBranchActive(b.id)}
                      >
                        <Power className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive"
                        onClick={() => removeBranch(b.id)}
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
      </div>

      {currentBranchId && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users className="size-5 text-primary" />
              <h2 className="font-display text-lg font-bold">تعيينات الفرع الحالي</h2>
            </div>
            <Button size="sm" onClick={() => setIsAssignOpen(true)}>
              <Plus className="size-3.5 ml-1.5" /> تعيين مستخدم
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">المستخدم</TableHead>
                <TableHead className="text-center px-4">الصلاحية</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments
                .filter((a) => a.branchId === currentBranchId)
                .map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="px-4 font-medium">{a.username}</TableCell>
                    <TableCell className="text-center px-4">
                      <Badge variant="outline">{describeRole(a.role)}</Badge>
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive"
                        onClick={() => unassignUser(a.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              {assignments.filter((a) => a.branchId === currentBranchId).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                    لم يتم تعيين أي مستخدم لهذا الفرع بعد
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add Branch Dialog */}
      <Dialog open={isBranchOpen} onOpenChange={setIsBranchOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة فرع جديد</DialogTitle>
            <DialogDescription>أدخل بيانات الفرع الجديد</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>اسم الفرع</Label>
              <Input
                value={branchForm.name}
                onChange={(e) => setBranchForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="مثال: فرع مدينة نصر"
              />
            </div>
            <div className="space-y-1.5">
              <Label>كود الفرع</Label>
              <Input
                value={branchForm.code}
                onChange={(e) => setBranchForm((f) => ({ ...f, code: e.target.value }))}
                placeholder="مثال: CAI-01"
                className="font-mono"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label>العنوان</Label>
              <Input
                value={branchForm.address}
                onChange={(e) => setBranchForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="العنوان بالتفصيل"
              />
            </div>
            <div className="space-y-1.5">
              <Label>الهاتف</Label>
              <Input
                value={branchForm.phone}
                onChange={(e) => setBranchForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="رقم الهاتف"
                dir="ltr"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsBranchOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={handleAddBranch} disabled={!branchForm.name || !branchForm.code}>
              <Plus className="size-4 ml-2" /> إضافة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign User Dialog */}
      <Dialog open={isAssignOpen} onOpenChange={setIsAssignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تعيين مستخدم للفرع</DialogTitle>
            <DialogDescription>
              سيتمكن المستخدم من العمل على بيانات هذا الفرع فقط (عند تفعيل النطاق)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>اسم المستخدم</Label>
              <Input
                value={assignForm.username}
                onChange={(e) => setAssignForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="اسم الموظف"
              />
            </div>
            <div className="space-y-1.5">
              <Label>الصلاحية</Label>
              <Select
                value={assignForm.role}
                onValueChange={(v) => setAssignForm((f) => ({ ...f, role: v as UserRole }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(USER_ROLE_LABELS) as UserRole[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {USER_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsAssignOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={handleAssign} disabled={!assignForm.username}>
              تعيين
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="text-xs text-muted-foreground/70 text-center">الجلسة الحالية: {username}</div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useUsersStore, type StaffRole, type StaffMember } from "@/store/useUsersStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Plus, Edit2, Trash2, Mail } from "lucide-react";

const ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: "مالك",
  MANAGER: "مدير",
  CASHIER: "أمين صندوق",
  VIEWER: "عارض فقط",
};

export function UserManagementPanel() {
  const { staffMembers, isLoading, fetchStaffMembers, inviteUser, updateUserRole, removeUser } = useUsersStore();
  
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<StaffMember | null>(null);
  
  // Form state
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<StaffRole>("CASHIER");
  
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStaffMembers();
  }, [fetchStaffMembers]);

  const handleInvite = async () => {
    if (!email) {
      setError("البريد الإلكتروني مطلوب");
      return;
    }
    setError(null);
    try {
      await inviteUser(email, role, name);
      setIsInviteOpen(false);
      setEmail("");
      setName("");
      setRole("CASHIER");
    } catch (err) {
      setError("حدث خطأ أثناء إرسال الدعوة");
    }
  };

  const handleUpdateRole = async () => {
    if (!selectedUser) return;
    try {
      await updateUserRole(selectedUser.id, role);
      setIsEditOpen(false);
      setSelectedUser(null);
    } catch (err) {
      setError("حدث خطأ أثناء تحديث الصلاحية");
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm("هل أنت متأكد من إزالة هذا المستخدم من المحل؟")) return;
    try {
      await removeUser(id);
    } catch (err) {
      console.error(err);
    }
  };

  const openInviteModal = () => {
    setError(null);
    setEmail("");
    setName("");
    setRole("CASHIER");
    setIsInviteOpen(true);
  };

  const openEditModal = (user: StaffMember) => {
    setError(null);
    setSelectedUser(user);
    setRole(user.role);
    setIsEditOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-2">
            <Users className="size-7 text-primary" />
            إدارة المستخدمين والصلاحيات
          </h1>
          <p className="text-muted-foreground mt-1">دعوة وإدارة فريق العمل الخاص بالمحل الحالي</p>
        </div>
        <Button onClick={openInviteModal} className="gap-2">
          <Plus className="size-4" /> إضافة مستخدم جديد
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>فريق العمل</CardTitle>
          <CardDescription>{staffMembers.length} مستخدم في المحل</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && staffMembers.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">جاري التحميل...</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الاسم / البريد</TableHead>
                    <TableHead className="text-center">الصلاحية</TableHead>
                    <TableHead className="text-center">الحالة</TableHead>
                    <TableHead className="text-center">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staffMembers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-semibold">{user.name}</span>
                          <span className="text-sm text-muted-foreground direction-ltr text-left w-max">
                            {user.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{ROLE_LABELS[user.role]}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={user.status === "ACTIVE" ? "default" : "secondary"}>
                          {user.status === "ACTIVE" ? "نشط" : "دعوة معلقة"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => openEditModal(user)}
                            disabled={user.role === "OWNER"}
                            title="تعديل الصلاحية"
                          >
                            <Edit2 className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-destructive"
                            onClick={() => handleRemove(user.id)}
                            disabled={user.role === "OWNER"}
                            title="إزالة المستخدم"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invite Modal */}
      <Dialog open={isInviteOpen} onOpenChange={setIsInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة مستخدم جديد</DialogTitle>
            <DialogDescription>
              سيتم إرسال دعوة للمستخدم على البريد الإلكتروني للانضمام إلى المحل.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            
            <div className="space-y-2">
              <label className="text-sm font-medium">البريد الإلكتروني</label>
              <div className="relative">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="direction-ltr text-left pl-10"
                />
                <Mail className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">الاسم (اختياري)</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="اسم المستخدم"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">الصلاحية</label>
              <Select value={role} onValueChange={(val) => setRole(val as StaffRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROLE_LABELS) as StaffRole[]).map((r) => (
                    <SelectItem key={r} value={r} disabled={r === "OWNER"}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setIsInviteOpen(false)} className="flex-1">
                إلغاء
              </Button>
              <Button onClick={handleInvite} disabled={isLoading} className="flex-1">
                {isLoading ? "جاري الإرسال..." : "إرسال الدعوة"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Role Modal */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تعديل الصلاحية</DialogTitle>
            <DialogDescription>
              تغيير صلاحية المستخدم {selectedUser?.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <Select value={role} onValueChange={(val) => setRole(val as StaffRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ROLE_LABELS) as StaffRole[]).map((r) => (
                  <SelectItem key={r} value={r} disabled={r === "OWNER"}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIsEditOpen(false)} className="flex-1">
                إلغاء
              </Button>
              <Button onClick={handleUpdateRole} disabled={isLoading} className="flex-1">
                {isLoading ? "جاري الحفظ..." : "حفظ التعديلات"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

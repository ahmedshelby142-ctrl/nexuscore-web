import { createFileRoute } from "@tanstack/react-router";
import { UserManagementPanel } from "@/components/auth/UserManagementPanel";

export const Route = createFileRoute("/users")({
  head: () => ({
    meta: [
      { title: "إدارة المستخدمين — NexusCore" },
      { name: "description", content: "إدارة المستخدمين والأدوار والصلاحيات" },
    ],
  }),
  component: UsersPage,
});

export function UsersPage() {
  return <UserManagementPanel />;
}

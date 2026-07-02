import { requireAdminPage } from "@/server/auth/current-user";

/** Server-side admin guard for every /system/* page (tasks, etc.). */
export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  return children;
}

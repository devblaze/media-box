import { requireAdminPage } from "@/server/auth/current-user";

/**
 * Server-side admin guard for every /settings/* page. Backs up the cosmetic
 * sidebar hiding + the per-route API guards: a non-admin who navigates directly
 * to /settings/indexers is redirected before the page renders.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  return children;
}

import { UiProviders } from "@/components/ui/providers";
import { AppShell } from "@/components/app-shell";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <UiProviders>
      <AppShell>{children}</AppShell>
    </UiProviders>
  );
}

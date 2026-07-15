import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, type ReactNode } from "react";
import { ConfigProvider, useConfig } from "@/lib/config";
import { theme } from "@/lib/theme";

SplashScreen.preventAutoHideAsync();

/** Holds the splash until persisted server/user have loaded, so the first frame
 * lands on the right screen (onboarding / login / browse) without a flicker. */
function Gate({ children }: { children: ReactNode }) {
  const { ready } = useConfig();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <ConfigProvider>
      <Gate>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
            animation: "fade",
          }}
        />
      </Gate>
    </ConfigProvider>
  );
}

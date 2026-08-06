import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { FirstRunHint } from "@/components/first-run-hint";
import { PosterRow } from "@/components/poster-row";
import { ProfileDrawer } from "@/components/profile-drawer";
import { logout } from "@/lib/api";
import { useConfig } from "@/lib/config";
import { theme } from "@/lib/theme";

const ROWS: { title: string; category: string }[] = [
  { title: "Recently Added", category: "recently-added" },
  { title: "Trending", category: "trending" },
  { title: "Popular Movies", category: "movies-popular" },
  { title: "Popular Series", category: "series-popular" },
  { title: "Popular Anime", category: "anime-popular" },
];

export default function Browse() {
  const router = useRouter();
  const { user, signOut, changeServer } = useConfig();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const initials = (user?.username ?? "?").slice(0, 2).toUpperCase();

  async function handleSignOut() {
    setDrawerOpen(false);
    try {
      await logout();
    } catch {
      // Even if the server call fails, drop the local session.
    }
    await signOut();
    router.replace("/login");
  }

  async function handleSwitchServer() {
    setDrawerOpen(false);
    await changeServer();
    router.replace("/onboarding");
  }

  // Swiping in from the right screen edge opens the drawer. The gesture lives
  // on a thin edge strip so it never fights the horizontal poster rows.
  const openDrawer = () => setDrawerOpen(true);
  const edgePan = Gesture.Pan()
    .activeOffsetX(-10)
    .onEnd((e) => {
      if (e.translationX < -30) runOnJS(openDrawer)();
    });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.brand}>
          MEDIA<Text style={styles.brandAccent}>BOX</Text>
        </Text>
        <Pressable onPress={() => setDrawerOpen(true)} hitSlop={8} style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {user && <Text style={styles.greeting}>Welcome back, {user.username}</Text>}
        {ROWS.map((row) => (
          <PosterRow key={row.category} title={row.title} category={row.category} />
        ))}
      </ScrollView>

      <GestureDetector gesture={edgePan}>
        <View style={styles.edgeZone} />
      </GestureDetector>

      <ProfileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSignOut={handleSignOut}
        onSwitchServer={handleSwitchServer}
      />
      <FirstRunHint />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  brand: { color: theme.text, fontSize: 20, fontWeight: "800", letterSpacing: 1 },
  brandAccent: { color: theme.accent },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: theme.accentText, fontSize: 13, fontWeight: "800" },
  scroll: { paddingTop: 8, paddingBottom: 32 },
  greeting: { color: theme.faint, fontSize: 14, paddingHorizontal: 16, marginBottom: 20 },
  edgeZone: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 20,
  },
});

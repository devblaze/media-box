import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PosterRow } from "@/components/poster-row";
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
  const { user, signOut } = useConfig();

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // Even if the server call fails, drop the local session.
    }
    await signOut();
    router.replace("/login");
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.brand}>
          MEDIA<Text style={styles.brandAccent}>BOX</Text>
        </Text>
        <Pressable onPress={handleSignOut} hitSlop={8}>
          <Text style={styles.signOut}>Sign out</Text>
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
  signOut: { color: theme.muted, fontSize: 14 },
  scroll: { paddingTop: 8, paddingBottom: 32 },
  greeting: { color: theme.faint, fontSize: 14, paddingHorizontal: 16, marginBottom: 20 },
});

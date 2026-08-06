import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { me, type SessionUser } from "@/lib/api";
import { useConfig } from "@/lib/config";
import { theme } from "@/lib/theme";

const DRAWER_W = 300;

interface ProfileDrawerProps {
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
  onSwitchServer: () => void;
}

/**
 * Right-side profile & settings panel. Slides in over the current screen;
 * closes via the backdrop, the ✕, or swiping it back toward the right edge.
 * Profile details refresh from /auth/me each time it opens (falling back to
 * the cached login identity when offline).
 */
export function ProfileDrawer({ open, onClose, onSignOut, onSwitchServer }: ProfileDrawerProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, serverUrl } = useConfig();
  const [profile, setProfile] = useState<SessionUser | null>(null);

  const translateX = useSharedValue(DRAWER_W);

  useEffect(() => {
    translateX.value = withTiming(open ? 0 : DRAWER_W, { duration: 220 });
    if (open) {
      me()
        .then(setProfile)
        .catch(() => setProfile(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - translateX.value / DRAWER_W,
  }));

  // Swipe the panel back toward the right edge to dismiss it.
  const closePan = Gesture.Pan()
    .activeOffsetX(10)
    .onUpdate((e) => {
      translateX.value = Math.max(0, Math.min(DRAWER_W, e.translationX));
    })
    .onEnd((e) => {
      if (e.translationX > DRAWER_W / 3 || e.velocityX > 500) {
        translateX.value = withTiming(DRAWER_W, { duration: 180 });
        runOnJS(onClose)();
      } else {
        translateX.value = withTiming(0, { duration: 180 });
      }
    });

  if (!open) return null;

  const username = profile?.username ?? user?.username ?? "";
  const role = profile?.role ?? user?.role ?? "";
  const initials = username.slice(0, 2).toUpperCase() || "?";
  const version = Constants.expoConfig?.version ?? "";

  return (
    <View style={[StyleSheet.absoluteFill, { width }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <GestureDetector gesture={closePan}>
        <Animated.View
          style={[
            styles.panel,
            { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
            panelStyle,
          ]}
        >
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>Profile &amp; Settings</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.profileRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={styles.profileMeta}>
              <Text style={styles.username}>{username}</Text>
              {!!role && <Text style={styles.role}>{role}</Text>}
            </View>
          </View>

          <Text style={styles.sectionLabel}>Server</Text>
          <View style={styles.card}>
            <Text style={styles.serverUrl} numberOfLines={1}>
              {serverUrl}
            </Text>
            <Pressable onPress={onSwitchServer} hitSlop={6}>
              <Text style={styles.link}>Switch server</Text>
            </Pressable>
          </View>

          <View style={styles.spacer} />

          <Pressable style={styles.signOut} onPress={onSignOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
          {!!version && <Text style={styles.version}>Media Box v{version}</Text>}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)" },
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: DRAWER_W,
    backgroundColor: theme.card,
    borderLeftWidth: 1,
    borderLeftColor: theme.border,
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  headerTitle: { color: theme.text, fontSize: 17, fontWeight: "700" },
  closeText: { color: theme.muted, fontSize: 16 },
  profileRow: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 28 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: theme.accentText, fontSize: 18, fontWeight: "800" },
  profileMeta: { flex: 1 },
  username: { color: theme.text, fontSize: 17, fontWeight: "700" },
  role: { color: theme.muted, fontSize: 13, marginTop: 2, textTransform: "capitalize" },
  sectionLabel: {
    color: theme.faint,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  card: {
    backgroundColor: theme.cardAlt,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  serverUrl: { color: theme.text, fontSize: 14 },
  link: { color: theme.accent, fontSize: 14, fontWeight: "600" },
  spacer: { flex: 1 },
  signOut: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  signOutText: { color: theme.danger, fontSize: 15, fontWeight: "600" },
  version: { color: theme.faint, fontSize: 12, textAlign: "center", marginTop: 14 },
});

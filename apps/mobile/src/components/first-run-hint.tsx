import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KEYS, storage } from "@/lib/storage";
import { theme } from "@/lib/theme";

/**
 * One-time coach mark shown on the first browse after signing in: tells the
 * user how to reach Profile & Settings (right-edge swipe or the avatar
 * button). Dismissal is persisted, so it never comes back.
 */
export function FirstRunHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    storage.get(KEYS.menuHintSeen).then((seen) => {
      if (!seen) setVisible(true);
    });
  }, []);

  if (!visible) return null;

  async function dismiss() {
    setVisible(false);
    await storage.set(KEYS.menuHintSeen, "1");
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={styles.backdrop} pointerEvents="none" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={styles.bubble}>
          <Text style={styles.arrow}>⟶</Text>
          <Text style={styles.title}>Profile &amp; Settings</Text>
          <Text style={styles.text}>
            Swipe in from the right edge of the screen — or tap your avatar in the top
            corner — to open your profile and settings.
          </Text>
          <Pressable style={styles.button} onPress={dismiss}>
            <Text style={styles.buttonText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  wrap: { flex: 1, alignItems: "flex-end", justifyContent: "center", paddingRight: 20 },
  bubble: {
    width: 270,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 18,
    gap: 8,
  },
  arrow: { color: theme.accent, fontSize: 22, alignSelf: "flex-end" },
  title: { color: theme.text, fontSize: 16, fontWeight: "700" },
  text: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 6,
  },
  buttonText: { color: theme.accentText, fontSize: 14, fontWeight: "700" },
});

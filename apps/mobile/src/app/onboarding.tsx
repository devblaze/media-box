import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { checkHealth } from "@/lib/api";
import { useConfig } from "@/lib/config";
import { theme } from "@/lib/theme";

/** Prepend http:// when the user omits a scheme, and trim trailing slashes. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export default function Onboarding() {
  const router = useRouter();
  const { saveServer } = useConfig();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const base = normalizeUrl(url);
    if (!base) {
      setError("Enter your server address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const health = await checkHealth(base);
      if (health.status !== "healthy") throw new Error("Server is not healthy");
      await saveServer(base);
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.brand}>
            MEDIA<Text style={styles.brandAccent}>BOX</Text>
          </Text>
          <Text style={styles.heading}>Connect to your server</Text>
          <Text style={styles.sub}>
            Enter the address of the media-box container running on your network.
          </Text>

          <Text style={styles.label}>Server address</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="http://192.168.1.10:7878"
            placeholderTextColor={theme.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            returnKeyType="go"
            onSubmitEditing={connect}
            editable={!busy}
          />
          <Text style={styles.hint}>
            Tip: it&apos;s the same address you open media-box at in a browser.
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={connect}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={theme.accentText} />
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", paddingHorizontal: 24, gap: 6 },
  brand: { color: theme.text, fontSize: 26, fontWeight: "800", letterSpacing: 1, marginBottom: 28 },
  brandAccent: { color: theme.accent },
  heading: { color: theme.text, fontSize: 24, fontWeight: "700" },
  sub: { color: theme.muted, fontSize: 15, lineHeight: 21, marginBottom: 20 },
  label: { color: theme.text, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  input: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: theme.text,
    fontSize: 16,
  },
  hint: { color: theme.faint, fontSize: 12, marginTop: 8 },
  error: { color: theme.danger, fontSize: 14, marginTop: 12 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 24,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: theme.accentText, fontSize: 16, fontWeight: "700" },
});

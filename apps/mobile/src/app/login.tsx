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
import { login } from "@/lib/api";
import { useConfig } from "@/lib/config";
import { theme } from "@/lib/theme";

export default function Login() {
  const router = useRouter();
  const { serverUrl, setUser, changeServer } = useConfig();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (!username || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(username, password);
      await setUser({ username: user.username, role: user.role });
      router.replace("/browse");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function switchServer() {
    await changeServer();
    router.replace("/onboarding");
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
          <Text style={styles.heading}>Sign in</Text>
          <Text style={styles.server} numberOfLines={1}>
            {serverUrl}
          </Text>

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="username"
            placeholderTextColor={theme.faint}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            editable={!busy}
          />

          <Text style={[styles.label, styles.labelSpaced]}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="password"
            placeholderTextColor={theme.faint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={signIn}
            editable={!busy}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={signIn}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={theme.accentText} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>

          <Pressable onPress={switchServer} disabled={busy} style={styles.linkWrap}>
            <Text style={styles.link}>Change server</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  brand: { color: theme.text, fontSize: 26, fontWeight: "800", letterSpacing: 1, marginBottom: 28 },
  brandAccent: { color: theme.accent },
  heading: { color: theme.text, fontSize: 24, fontWeight: "700" },
  server: { color: theme.faint, fontSize: 13, marginTop: 4, marginBottom: 24 },
  label: { color: theme.text, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  labelSpaced: { marginTop: 16 },
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
  error: { color: theme.danger, fontSize: 14, marginTop: 14 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 24,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: theme.accentText, fontSize: 16, fontWeight: "700" },
  linkWrap: { alignItems: "center", marginTop: 20 },
  link: { color: theme.muted, fontSize: 14 },
});

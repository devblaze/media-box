import { Redirect } from "expo-router";
import { useConfig } from "@/lib/config";

/**
 * Entry gate. Sends the user to the right first screen based on what's stored:
 * no server → onboarding; server but no session → login; both → browse.
 */
export default function Index() {
  const { serverUrl, user } = useConfig();
  if (!serverUrl) return <Redirect href="/onboarding" />;
  if (!user) return <Redirect href="/login" />;
  return <Redirect href="/browse" />;
}

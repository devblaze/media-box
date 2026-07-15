import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Tiny persistence wrapper. Uses AsyncStorage, which is backed by the native
 * key-value store on iOS/Android and by localStorage on web (so Expo-web builds
 * work too). Values here are non-secret (server URL, cached username); the auth
 * cookie itself lives in the platform's native cookie store, set on login.
 */
export const storage = {
  get: (key: string) => AsyncStorage.getItem(key),
  set: (key: string, value: string) => AsyncStorage.setItem(key, value),
  remove: (key: string) => AsyncStorage.removeItem(key),
};

export const KEYS = {
  serverUrl: "mediabox.serverUrl",
  user: "mediabox.user",
} as const;

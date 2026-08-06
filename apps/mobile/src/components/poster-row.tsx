import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { discover, getSeriesResume, type DiscoverItem } from "@/lib/api";
import { theme } from "@/lib/theme";

const CARD_W = 120;
const CARD_H = 180; // 2:3 poster

function PosterCard({ item }: { item: DiscoverItem }) {
  const router = useRouter();
  const busyRef = useRef(false);

  async function open() {
    if (busyRef.current) return;
    if (item.status !== "available" || item.mediaId == null) {
      Alert.alert(item.title, "Not in your library yet — add it from the media-box web app.");
      return;
    }
    if (item.mediaType === "movie") {
      router.push({
        pathname: "/player",
        params: { type: "movie", id: String(item.mediaId), title: item.title },
      });
      return;
    }
    // Series: ask the server which episode Play should open (continue
    // watching, or the first available one).
    busyRef.current = true;
    try {
      const resume = await getSeriesResume(item.mediaId);
      if (!resume.episode) {
        Alert.alert(item.title, "No playable episode yet.");
        return;
      }
      const ep = resume.episode;
      router.push({
        pathname: "/player",
        params: {
          type: "episode",
          id: String(ep.id),
          title: `${item.title} · S${ep.seasonNumber}E${ep.episodeNumber}`,
        },
      });
    } catch {
      Alert.alert(item.title, "Could not start playback. Is the server reachable?");
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <Pressable style={styles.card} onPress={open}>
      {item.poster ? (
        <Image
          source={{ uri: item.poster }}
          style={styles.poster}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={[styles.poster, styles.posterFallback]}>
          <Text style={styles.fallbackText} numberOfLines={3}>
            {item.title}
          </Text>
        </View>
      )}
      {item.status === "available" && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✓</Text>
        </View>
      )}
      <Text style={styles.cardTitle} numberOfLines={1}>
        {item.title}
      </Text>
    </Pressable>
  );
}

/**
 * A titled, horizontally-scrolling row backed by one /discover category. Silent
 * (renders nothing) when a category comes back empty, so the browse screen stays
 * tidy if e.g. no anime is trending.
 */
export function PosterRow({ title, category }: { title: string; category: string }) {
  const [items, setItems] = useState<DiscoverItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    discover(category)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [category]);

  if (items && items.length === 0) return null;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      {error ? (
        <Text style={styles.rowError}>{error}</Text>
      ) : items ? (
        <FlatList
          horizontal
          data={items}
          keyExtractor={(it) => `${it.mediaType}-${it.tmdbId}`}
          renderItem={({ item }) => <PosterCard item={item} />}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
        />
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 24 },
  rowTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  rowError: { color: theme.faint, fontSize: 13, paddingHorizontal: 16 },
  loading: { height: CARD_H, justifyContent: "center", paddingHorizontal: 16 },
  listContent: { paddingHorizontal: 16, gap: 12 },
  card: { width: CARD_W },
  poster: { width: CARD_W, height: CARD_H, borderRadius: 8, backgroundColor: theme.card },
  posterFallback: { alignItems: "center", justifyContent: "center", padding: 8 },
  fallbackText: { color: theme.muted, fontSize: 12, textAlign: "center" },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: theme.success,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: theme.accentText, fontSize: 11, fontWeight: "800" },
  cardTitle: { color: theme.muted, fontSize: 12, marginTop: 6 },
});

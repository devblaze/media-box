import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { discover, type DiscoverItem } from "@/lib/api";
import { theme } from "@/lib/theme";

const CARD_W = 120;
const CARD_H = 180; // 2:3 poster

function PosterCard({ item }: { item: DiscoverItem }) {
  return (
    <View style={styles.card}>
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
    </View>
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

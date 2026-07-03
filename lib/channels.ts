// Shared, dependency-free channel constants usable from both server (scheduler)
// and client (pages/components) without bundling any server-only modules.

export type Channel = "movies" | "series" | "anime";

export const CHANNELS: Channel[] = ["movies", "series", "anime"];

export const CHANNEL_LABEL: Record<Channel, string> = {
  movies: "Movies",
  series: "Series",
  anime: "Anime",
};

export function isChannel(x: string): x is Channel {
  return (CHANNELS as string[]).includes(x);
}

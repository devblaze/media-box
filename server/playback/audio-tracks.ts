import { resolveMediaPath, type MediaType } from "@/server/library/resolve-media";
import { probeAudioTracks, type AudioStream } from "@/server/library/media-info";

/** An audio stream plus a human-friendly label for the player's track picker. */
export interface AudioTrackInfo extends AudioStream {
  label: string;
}

const LANG_NAMES: Record<string, string> = {
  en: "English",
  eng: "English",
  ja: "Japanese",
  jpn: "Japanese",
  es: "Spanish",
  spa: "Spanish",
  fr: "French",
  fre: "French",
  fra: "French",
  de: "German",
  ger: "German",
  deu: "German",
  it: "Italian",
  ita: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  zho: "Chinese",
  el: "Greek",
  ell: "Greek",
  gre: "Greek",
};

function channelLabel(channels: number | null): string | null {
  switch (channels) {
    case 1:
      return "Mono";
    case 2:
      return "Stereo";
    case 6:
      return "5.1";
    case 8:
      return "7.1";
    default:
      return channels ? `${channels}ch` : null;
  }
}

function buildLabel(s: AudioStream, index: number): string {
  const lang = s.language ? (LANG_NAMES[s.language.toLowerCase()] ?? s.language.toUpperCase()) : null;
  const ch = channelLabel(s.channels);
  const parts = [lang ?? `Track ${index + 1}`, ch, s.codec ? s.codec.toUpperCase() : null].filter(
    Boolean
  );
  let label = parts.join(" · ");
  // A descriptive stream title (e.g. "Commentary", "Signs & Songs") is very useful.
  if (s.title && !label.toLowerCase().includes(s.title.toLowerCase())) label += ` · ${s.title}`;
  return label;
}

/**
 * All audio tracks in a movie/episode file, labelled for the player's audio-track
 * picker. Empty when the file has one/no audio track or ffprobe is unavailable.
 * Multi-track anime (JP + EN dub, commentaries) is the main reason this exists —
 * transcoding the wrong first track is a common "no sound" cause.
 */
export async function listAudioTracks(target: { kind: MediaType; id: number }): Promise<AudioTrackInfo[]> {
  const resolved = resolveMediaPath(target.kind, target.id);
  if (!resolved) return [];
  const streams = await probeAudioTracks(resolved.absPath);
  return streams.map((s) => ({ ...s, label: buildLabel(s, s.index) }));
}

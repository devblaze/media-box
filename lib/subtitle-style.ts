import type { CSSProperties } from "react";

/**
 * Per-viewer subtitle appearance. This is a playback display preference (like
 * caption styling on Netflix/Jellyfin), stored in the browser so it applies
 * instantly in the player without a round-trip. Chosen on the Account page and
 * read by the video player, which renders subtitles as its own styled overlay.
 */
export type SubtitleFontSize = "sm" | "md" | "lg" | "xl";
export type SubtitleBackground = "none" | "semi" | "solid";
export type SubtitleEdge = "none" | "outline" | "shadow";
export type SubtitleFontFamily = "sans" | "serif" | "mono";

export interface SubtitleStyle {
  fontSize: SubtitleFontSize;
  /** Text colour as a hex string, e.g. "#ffffff". */
  color: string;
  background: SubtitleBackground;
  edge: SubtitleEdge;
  fontFamily: SubtitleFontFamily;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: "md",
  color: "#ffffff",
  background: "semi",
  edge: "outline",
  fontFamily: "sans",
};

/** Preset text colours offered as quick swatches (plus a custom picker). */
export const SUBTITLE_COLOR_PRESETS: { label: string; value: string }[] = [
  { label: "White", value: "#ffffff" },
  { label: "Yellow", value: "#f5d90a" },
  { label: "Cyan", value: "#57d0ff" },
  { label: "Green", value: "#5ce65c" },
];

const STORAGE_KEY = "mediabox.subtitleStyle";

export function loadSubtitleStyle(): SubtitleStyle {
  if (typeof window === "undefined") return DEFAULT_SUBTITLE_STYLE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SUBTITLE_STYLE;
    const parsed = JSON.parse(raw) as Partial<SubtitleStyle>;
    // Merge over defaults so a partial/old blob still yields a complete style.
    return { ...DEFAULT_SUBTITLE_STYLE, ...parsed };
  } catch {
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function saveSubtitleStyle(style: SubtitleStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* storage disabled or over quota — non-fatal, the style just isn't remembered */
  }
}

// ── Subtitle language preference ─────────────────────────────────────────────
// Remembers the viewer's last subtitle choice — a language (optionally a track
// kind), or explicitly "off" — so the player auto-selects it on the next episode
// / title instead of always starting off. Stored in the browser, like the style.

export type SubtitlePref =
  | { off: true }
  | { off: false; lang: string; kind?: "external" | "embedded" };

const SUBTITLE_PREF_KEY = "mediabox.subtitlePref";

// ffprobe tags subtitles in ISO 639-2 ("eng"); sidecars use 639-1 ("en"). Fold
// the common 3-letter codes to 2 so an embedded track and a sidecar of the same
// language match when we auto-apply a saved preference.
const LANG_3_TO_2: Record<string, string> = {
  eng: "en",
  jpn: "ja",
  spa: "es",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  ita: "it",
  por: "pt",
  dut: "nl",
  nld: "nl",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  rus: "ru",
  ara: "ar",
  gre: "el",
  ell: "el",
};

export function normalizeSubtitleLang(code: string): string {
  const c = (code || "").toLowerCase();
  return LANG_3_TO_2[c] ?? c;
}

export function loadSubtitlePref(): SubtitlePref | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SUBTITLE_PREF_KEY);
    return raw ? (JSON.parse(raw) as SubtitlePref) : null;
  } catch {
    return null;
  }
}

export function saveSubtitlePref(pref: SubtitlePref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUBTITLE_PREF_KEY, JSON.stringify(pref));
  } catch {
    /* storage disabled or over quota — non-fatal, the choice just isn't remembered */
  }
}

/**
 * Index of the track that best matches a saved preference, or -1 (off / no match):
 * an exact language + kind match first, then any track in that language.
 */
export function matchSubtitlePref(
  tracks: { language: string; kind?: "external" | "embedded" }[],
  pref: SubtitlePref | null
): number {
  if (!pref || pref.off) return -1;
  const want = normalizeSubtitleLang(pref.lang);
  const exact = tracks.findIndex(
    (t) => normalizeSubtitleLang(t.language) === want && t.kind === pref.kind
  );
  if (exact >= 0) return exact;
  return tracks.findIndex((t) => normalizeSubtitleLang(t.language) === want);
}

// Player sizes are viewport-relative so they scale with the full-screen video;
// the settings preview uses fixed px so it reads correctly in a small box.
const FONT_SIZE_VH: Record<SubtitleFontSize, string> = {
  sm: "2.4vh",
  md: "3.1vh",
  lg: "3.9vh",
  xl: "4.9vh",
};
const FONT_SIZE_PX: Record<SubtitleFontSize, string> = {
  sm: "15px",
  md: "19px",
  lg: "25px",
  xl: "31px",
};

const FONT_FAMILY_CSS: Record<SubtitleFontFamily, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
};

function edgeShadow(edge: SubtitleEdge): string {
  switch (edge) {
    case "outline":
      return "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.9)";
    case "shadow":
      return "0 2px 4px rgba(0,0,0,0.95)";
    case "none":
    default:
      return "none";
  }
}

function backgroundColor(bg: SubtitleBackground): string {
  switch (bg) {
    case "semi":
      return "rgba(0,0,0,0.55)";
    case "solid":
      return "rgba(0,0,0,0.9)";
    case "none":
    default:
      return "transparent";
  }
}

/** Inline styles for a subtitle text box. `preview` swaps to fixed px sizing. */
export function subtitleTextStyle(
  style: SubtitleStyle,
  opts?: { preview?: boolean }
): CSSProperties {
  const boxed = style.background !== "none";
  return {
    display: "inline-block",
    maxWidth: "100%",
    fontSize: (opts?.preview ? FONT_SIZE_PX : FONT_SIZE_VH)[style.fontSize],
    color: style.color,
    fontFamily: FONT_FAMILY_CSS[style.fontFamily],
    fontWeight: 600,
    lineHeight: 1.35,
    textShadow: edgeShadow(style.edge),
    backgroundColor: backgroundColor(style.background),
    padding: boxed ? "0.1em 0.5em" : 0,
    borderRadius: boxed ? "0.2em" : 0,
    whiteSpace: "pre-line",
    textAlign: "center",
  };
}

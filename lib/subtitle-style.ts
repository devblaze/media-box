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

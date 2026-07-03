/** Language-code + text-decoding helpers shared by subtitle providers. */

// ISO 639-1 → ISO 639-2 (as used by OpenSubtitles.org's `sublanguageid`).
const ISO1_TO_2: Record<string, string> = {
  en: "eng", el: "ell", es: "spa", fr: "fre", de: "ger", it: "ita", pt: "por",
  nl: "dut", ru: "rus", ja: "jpn", ko: "kor", zh: "chi", ar: "ara", tr: "tur",
  pl: "pol", sv: "swe", da: "dan", fi: "fin", no: "nor", cs: "cze", hu: "hun",
  ro: "rum", bg: "bul", hr: "hrv", sr: "scc", uk: "ukr", he: "heb", hi: "hin",
  th: "tha", vi: "vie", id: "ind",
};

export function iso6392(iso1: string): string {
  return ISO1_TO_2[iso1.toLowerCase()] ?? iso1.toLowerCase();
}

function normalizeEncoding(label: string): string {
  const m = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (m === "cp1253" || m === "windows1253") return "windows-1253";
  if (m === "iso88597" || m === "greek" || m === "eliso") return "iso-8859-7";
  if (m === "cp1251" || m === "windows1251") return "windows-1251";
  if (m === "utf8") return "utf-8";
  return label;
}

/**
 * Decode raw subtitle bytes to a string. Greek (and other legacy) subtitles are
 * frequently windows-1253 / ISO-8859-7 rather than UTF-8; when the provider tells
 * us the charset we honor it, otherwise we fall back to UTF-8. `TextDecoder`
 * throws `RangeError` for an unknown label, so we try/next.
 */
export function decodeSubtitle(buf: Uint8Array, encoding?: string | null): string {
  const labels = [encoding, "utf-8"].filter(Boolean) as string[];
  for (const label of labels) {
    try {
      return new TextDecoder(normalizeEncoding(label)).decode(buf);
    } catch {
      /* unsupported label — try the next */
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}

/** IMDb id → numeric string ("tt1234567" | "1234567" → "1234567"). */
export function imdbNumeric(id?: string | null): string | undefined {
  if (!id) return undefined;
  const n = id.replace(/^tt/i, "").replace(/\D/g, "");
  return n || undefined;
}

/**
 * Hand-install instructions for the media-box Android app on a TV.
 *
 * When the app can't be pushed to a device over the network, someone has to
 * sideload the APK with the remote in their hand — and the menus differ a lot
 * between Fire TV, Google TV and plain Android TV (an older Sony or Philips set
 * hides "Unknown sources" somewhere else again). So we ask the configured AI
 * provider for steps that name that device's real on-screen items, and fall
 * back to built-in generic steps whenever there is no provider or the model
 * misbehaves.
 *
 * Everything the model returns is untrusted text headed for a browser:
 * `parseSteps` keeps plain prose only (no markup, no URI schemes), and
 * `enforceKnownUrls` makes sure the address in the steps is still the one this
 * server handed out rather than something the model invented.
 */
import { aiEnabled, chatText } from "@/server/ai/llm";

/** Whatever the person could tell us about their TV — all of it optional. */
export interface TvDevice {
  brand?: string;
  model?: string;
  os?: string;
}

export interface InstallSteps {
  steps: string[];
  source: "ai" | "builtin";
  /** Why these are the built-in steps rather than the device-specific ones. */
  warning?: string;
}

/** Never show more steps than this, whoever wrote them. */
export const MAX_STEPS = 12;
/** Longest a single step may be before it is cut short. */
export const MAX_STEP_CHARS = 300;
/** Fewer steps than this is not a usable answer. */
const MIN_AI_STEPS = 3;
/** A page is waiting on this call, so keep it well under the client's patience. */
const AI_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Built-in steps                                                             */
/* -------------------------------------------------------------------------- */

type DeviceFamily = "fire" | "googletv" | "androidtv" | "non-android";

/** Best guess at which menu layout this device has, from free-text fields. */
function detectFamily(device: TvDevice): DeviceFamily {
  const hay = [device.brand, device.model, device.os].join(" ").toLowerCase();
  if (/fire\s?tv|fire\s?stick|fire\s?os|\baftv|\bamazon\b/.test(hay)) return "fire";
  if (/google\s?tv|chromecast/.test(hay)) return "googletv";
  if (/android/.test(hay)) return "androidtv";
  // Only claim a TV can't run Android apps when it says so itself.
  if (/roku|web\s?os|tizen|smartcast|tvos|apple\s?tv|\blg\b|samsung|vizio/.test(hay)) return "non-android";
  return "androidtv";
}

/** The address a person has to type on a remote: the short one when we have it. */
function typeableUrl(downloadUrl: string, shortUrl: string): string {
  return shortUrl.trim() || downloadUrl.trim();
}

function fireTvSteps(typeUrl: string): string[] {
  return [
    'From the Fire TV home screen open search (the magnifying glass), search for "Downloader" and install the free orange Downloader app by AFTVnews. It has to be installed before the next step, because the permission is granted per app.',
    "Open Settings (the gear icon in the top row), then My Fire TV, then Developer options.",
    "If Developer options is missing, open My Fire TV, then About, highlight your device's name and press the select button seven times, then go back one screen.",
    'In Developer options open "Install unknown apps" and switch Downloader to ON. Older Fire OS versions have a single "Apps from Unknown Sources" switch instead - turn that on.',
    `Open Downloader, select the URL box at the top of its Home tab, and type this address exactly: ${typeUrl}`,
    "Press Go and wait for the download to finish.",
    "When the installer appears, choose Install, then Install again on the confirmation screen.",
    "Choose Open to start media-box. If you choose Done instead, let Downloader delete the .apk file - the app is already installed.",
  ];
}

function googleTvSteps(typeUrl: string): string[] {
  return [
    'On the TV open the Apps row or the Google Play Store, search for "Downloader by AFTVnews" and install it. Install it first: the permission below is granted per app.',
    "Open Settings (your profile icon, top right), then Apps, then Security & restrictions, then Unknown sources.",
    'If Security & restrictions is not listed, turn on developer options first: Settings, then System, then About, then press "Android TV OS build" seven times, and come back.',
    "Switch Unknown sources ON for Downloader.",
    `Open Downloader, select the URL box at the top and type this address exactly: ${typeUrl}`,
    "Press Go and wait for the download to finish. Downloader's built-in browser is disabled on Google TV, but the URL box still works.",
    "When the installer appears, choose Install, then Install again on the confirmation screen.",
    "Choose Open to start media-box, or Done and then Delete to remove the downloaded .apk file.",
  ];
}

function androidTvSteps(typeUrl: string): string[] {
  return [
    'On the TV open the Google Play Store, search for "Downloader by AFTVnews" and install it. Any app that can fetch a file from a web address will do if that one is unavailable.',
    "Open Settings, then Device Preferences, then Security & restrictions, then Unknown sources. On older Sony and Philips sets it is Settings, then Personal or Security & restrictions, then Unknown sources.",
    "Switch Unknown sources ON for Downloader - the switch is per app, not one global setting.",
    `Open Downloader, select the URL box at the top and type this address exactly: ${typeUrl}`,
    "Press Go and wait for the download to finish.",
    "When the installer appears, choose Install, then Install again on the confirmation screen.",
    "Choose Open to start media-box, or Done and then Delete to remove the downloaded .apk file.",
    "If the install is refused, go back and check that Unknown sources is on for the app that did the downloading.",
  ];
}

function nonAndroidSteps(typeUrl: string): string[] {
  return [
    "The media-box TV app is an Android app (an .apk file), and this TV's system only installs apps from its own store - Roku, LG webOS, Samsung Tizen and Apple tvOS all work that way.",
    "To get the app onto this TV, plug in a small Android device: a Fire TV Stick, a Chromecast with Google TV, or any Android TV box.",
    'On that device install the free "Downloader by AFTVnews" app, then allow installs from unknown sources for it in the device\'s security settings.',
    `Open Downloader on that device, type this address exactly into the URL box and press Go: ${typeUrl}`,
    "When the installer appears choose Install, then Open.",
    "Until then, media-box still works in a web browser on any phone, tablet or computer on the same network.",
  ];
}

/**
 * Generic sideloading steps that are always available: no AI, no I/O, no
 * failure mode. Branches on the device family because the menu path to
 * "unknown sources" is the one thing that genuinely differs between TVs.
 *
 * Never sets `warning` — that field means "you are seeing the built-in steps
 * because the device-specific ones didn't work out".
 */
export function builtinSteps(
  device: TvDevice,
  downloadUrl: string,
  shortUrl: string
): InstallSteps {
  const typeUrl = typeableUrl(downloadUrl, shortUrl);
  const family = detectFamily(device);
  const steps =
    family === "fire"
      ? fireTvSteps(typeUrl)
      : family === "googletv"
        ? googleTvSteps(typeUrl)
        : family === "non-android"
          ? nonAndroidSteps(typeUrl)
          : androidTvSteps(typeUrl);

  const full = downloadUrl.trim();
  if (full && full !== typeUrl) {
    steps.push(`If you can paste instead of typing, the full download link is: ${full}`);
  }
  return { steps: steps.slice(0, MAX_STEPS), source: "builtin" };
}

/* -------------------------------------------------------------------------- */
/* Parsing and sanitising the model's reply                                   */
/* -------------------------------------------------------------------------- */

/** "1. ", "2) ", "Step 3: ", "(4) ", "- ", "* " — anything a model calls a step. */
const MARKER = /^(?:step\s*)?\d{1,2}\s*[.)\]:-]\s*|^\(\s*\d{1,2}\s*\)\s*|^[-*•‣·–—]\s+/i;

/** A "<" that starts a tag or a comment. Menu paths use ">", never "<x". */
const HTML_LIKE = /<\s*\/?\s*[a-z!]/i;

/** Schemes that only ever exist to smuggle code past a renderer. */
function hasDangerousScheme(text: string): boolean {
  // Whitespace-stripped so "java script:" can't sneak through.
  const flat = text.replace(/\s+/g, "").toLowerCase();
  if (/(?:javascript|vbscript|jscript|livescript):/.test(flat)) return true;
  // Checked on the spaced text so the word "metadata:" isn't mistaken for one.
  if (/\bdata\s*:[a-z0-9.+-]*[;,/]/i.test(text)) return true;
  return /\bfile\s*:\/\//i.test(text);
}

/** Models sometimes cram the whole list onto one line: "1. a 2. b 3. c". */
function splitRun(line: string): string[] {
  const marks = line.match(/(?:^|\s)\d{1,2}[.)]\s/g);
  if (!marks || marks.length < 3) return [line];
  return line.split(/\s+(?=\d{1,2}[.)]\s)/);
}

function stripMarker(line: string): { text: string; isItem: boolean } {
  const m = MARKER.exec(line);
  return m ? { text: line.slice(m[0].length), isItem: true } : { text: line, isItem: false };
}

/** One step's worth of text, or null when nothing safe and useful is left. */
function sanitizeStep(input: string): string | null {
  // Control and direction-changing characters first: they hide everything else.
  let text = input.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ");
  if (HTML_LIKE.test(text)) return null;
  if (hasDangerousScheme(text)) return null;

  text = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) -> label, url discarded
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // [label][ref] -> label
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) text = text.slice(1, -1).trim();
  if (text.length < 3) return null;
  if (text.length > MAX_STEP_CHARS) {
    text = `${text.slice(0, MAX_STEP_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Turn a model reply into plain-text steps, dropping anything that isn't prose.
 *
 * Pure and total: markup, scripts and URI schemes are removed rather than
 * escaped, the list is capped at `MAX_STEPS` and each step at `MAX_STEP_CHARS`.
 * When the reply contains a list, only the list items survive — that is what
 * strips "Sure, here are the steps!" and any trailing chatter.
 */
export function parseSteps(raw: string): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^(?:```|~~~)/.test(trimmed)) continue; // code fence
    if (/^#{1,6}\s/.test(trimmed)) continue; // heading
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) continue; // horizontal rule
    lines.push(...splitRun(trimmed));
  }

  const marked = lines.map((l) => stripMarker(l.trim()));
  const items = marked.some((m) => m.isItem) ? marked.filter((m) => m.isItem) : marked;

  const steps: string[] = [];
  for (const item of items) {
    const clean = sanitizeStep(item.text);
    if (clean) steps.push(clean);
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

/* -------------------------------------------------------------------------- */
/* The download address is ours, not the model's                              */
/* -------------------------------------------------------------------------- */

/**
 * Hosts a model legitimately names while telling someone where to get the
 * Downloader app. They are never where media-box itself is downloaded from, so
 * seeing one is not a substituted address.
 */
const BENIGN_HOST_SUFFIXES = ["google.com", "amazon.com", "aftvnews.com"];

/** Anything address-shaped: scheme://…, www.…, host[:port]/path, host:port. */
function urlPattern(): RegExp {
  const host = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)`;
  return new RegExp(
    [
      String.raw`[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+`,
      String.raw`www\.[^\s<>"']+`,
      `${host}(?::\\d{2,5})?\\/[^\\s<>"']*`,
      `${host}:\\d{2,5}`,
    ].join("|"),
    "gi"
  );
}

function parseUrlish(token: string): { host: string; full: string } | null {
  const cleaned = token.replace(/[.,;:!?)\]]+$/, "");
  if (cleaned === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`;
  try {
    const u = new URL(withScheme);
    if (!u.host) return null;
    const host = u.host.toLowerCase();
    return { host, full: `${host}${u.pathname.replace(/\/+$/, "")}${u.search}` };
  } catch {
    return null;
  }
}

function isBenignHost(host: string): boolean {
  const bare = host.split(":")[0];
  return BENIGN_HOST_SUFFIXES.some((b) => bare === b || bare.endsWith(`.${b}`));
}

/**
 * The download address is a fact this server knows, so the model is not allowed
 * to change it. Every address-shaped token in the steps is checked against the
 * two URLs we handed it:
 *
 * - exactly ours, or a well-known app-store host: left alone;
 * - our host but a different path (the model "tidied" the URL): repaired back
 *   to the typeable address;
 * - any other host: rejected outright — returns null so the caller can fall
 *   back, because a wrong host is either a hallucination or a redirection.
 *
 * Returns null too when the steps never mention our address at all: steps that
 * don't say what to type are not steps.
 */
export function enforceKnownUrls(
  steps: string[],
  downloadUrl: string,
  shortUrl: string
): string[] | null {
  const typeUrl = typeableUrl(downloadUrl, shortUrl);
  const ours = [downloadUrl, shortUrl].map((u) => (u ?? "").trim()).filter(Boolean);
  const allowedHosts = new Set<string>();
  const allowedFull = new Set<string>();
  for (const u of ours) {
    const parsed = parseUrlish(u);
    if (!parsed) continue;
    allowedHosts.add(parsed.host);
    allowedFull.add(parsed.full);
  }

  let foreign = false;
  let mentionsOurs = false;

  const out = steps.map((step) => {
    if (ours.some((u) => step.includes(u))) mentionsOurs = true;
    return step.replace(urlPattern(), (raw) => {
      const trail = /[.,;:!?)\]]+$/.exec(raw)?.[0] ?? "";
      const parsed = parseUrlish(raw);
      if (!parsed) return raw;
      if (allowedFull.has(parsed.full)) {
        mentionsOurs = true;
        return raw;
      }
      if (allowedHosts.has(parsed.host)) {
        mentionsOurs = true;
        return `${typeUrl}${trail}`;
      }
      if (isBenignHost(parsed.host)) return raw;
      foreign = true;
      return raw;
    });
  });

  if (foreign || !mentionsOurs) return null;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Device-specific steps from the configured model                            */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  "You write instructions for installing an Android app (an .apk file) by hand onto a TV device, for someone holding a TV remote.",
  "Reply with the numbered steps only. No preamble, no closing remarks, no markdown, no HTML, no links, no code fences.",
  "Rules:",
  '- One step per line, each starting "1. ", "2. ", and so on. At most 10 steps.',
  "- Plain text sentences only. Never use bold, bullets, backticks, tags or angle brackets.",
  "- Name the exact on-screen menu items for THIS device where you know them (for example a Fire TV's Settings, My Fire TV, Developer options). If you are not sure what a menu is called on this device, describe it plainly instead of inventing a name.",
  "- Cover, in order: installing a download app such as Downloader by AFTVnews, allowing installs from unknown sources for it, entering the address, and installing the downloaded file.",
  "- The download address is given to you in the user message. Use it verbatim, character for character. Never shorten it, never change its host, never invent another address, and never send the person to an app store to get this app.",
  "- The person is typing with a remote, so tell them to enter the short address you were given.",
].join("\n");

/** Free text from a form goes into a prompt, so keep it short and single-line. */
function promptField(value: string | undefined): string {
  const clean = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return clean || "unknown";
}

function buildUserPrompt(device: TvDevice, downloadUrl: string, shortUrl: string): string {
  const typeUrl = typeableUrl(downloadUrl, shortUrl);
  const full = downloadUrl.trim();
  return [
    "Device:",
    `- Brand: ${promptField(device.brand)}`,
    `- Model: ${promptField(device.model)}`,
    `- System: ${promptField(device.os)}`,
    "",
    `Short address to type on the TV (use exactly this text): ${typeUrl}`,
    ...(full && full !== typeUrl ? [`Full link, only for a device that can paste: ${full}`] : []),
    "",
    "Write the numbered steps for installing the media-box app on this device.",
  ].join("\n");
}

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 120) || "no details";
}

function fallback(base: InstallSteps, warning: string): InstallSteps {
  return { ...base, warning };
}

/**
 * Install steps for one device: the configured model's, when it is configured
 * and its answer survives sanitising and the address check, otherwise the
 * built-in ones with a note saying why.
 *
 * Never throws and never rejects — the page that calls this always has
 * something to render.
 */
export async function deviceSteps(
  device: TvDevice,
  downloadUrl: string,
  shortUrl: string
): Promise<InstallSteps> {
  const generic = () => builtinSteps(device, downloadUrl, shortUrl);

  let enabled = false;
  try {
    enabled = aiEnabled();
  } catch {
    enabled = false; // Settings unreadable — no assistant, no warning worth showing.
  }
  if (!enabled) return generic();

  try {
    const raw = await chatText(SYSTEM_PROMPT, buildUserPrompt(device, downloadUrl, shortUrl), {
      timeoutMs: AI_TIMEOUT_MS,
    });
    const parsed = parseSteps(raw);
    if (parsed.length < MIN_AI_STEPS) {
      return fallback(
        generic(),
        "The AI assistant's answer didn't look like install steps, so these are the standard ones."
      );
    }
    const checked = enforceKnownUrls(parsed, downloadUrl, shortUrl);
    if (!checked) {
      return fallback(
        generic(),
        "The AI assistant didn't use this server's download address, so these are the standard ones."
      );
    }
    return { steps: checked, source: "ai" };
  } catch (err) {
    return fallback(
      generic(),
      `The AI assistant couldn't write steps for this device (${shortReason(err)}), so these are the standard ones.`
    );
  }
}

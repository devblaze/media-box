/**
 * Sideloading instructions for a TV.
 *
 * Two things matter here beyond "does it produce steps": the model's reply is
 * untrusted text on its way into a browser, and the download address is a fact
 * the server owns. So the parser has to strip markup and URI schemes, and a
 * reply that points anywhere but this server has to be thrown away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiEnabledMock = vi.fn<() => boolean>();
const chatTextMock =
  vi.fn<(system: string, user: string, opts?: { timeoutMs?: number }) => Promise<string>>();

vi.mock("@/server/ai/llm", () => ({
  aiEnabled: () => aiEnabledMock(),
  chatText: (system: string, user: string, opts?: { timeoutMs?: number }) =>
    chatTextMock(system, user, opts),
}));

const { MAX_STEPS, MAX_STEP_CHARS, builtinSteps, deviceSteps, enforceKnownUrls, parseSteps } =
  await import("./tv-instructions");

const DOWNLOAD_URL = "http://192.168.1.50:8080/api/v1/apps/android/download?token=abc123";
const SHORT_URL = "192.168.1.50:8080/a/7f2";

describe("builtinSteps", () => {
  it("always produces usable steps", () => {
    const res = builtinSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(res.warning).toBeUndefined();
    expect(res.steps.length).toBeGreaterThan(3);
    expect(res.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(res.steps.every((s) => s.trim().length > 0)).toBe(true);
  });

  it("has you type the short address, not the tokenized one", () => {
    const typed = builtinSteps({ os: "Android TV" }, DOWNLOAD_URL, SHORT_URL).steps.find((s) =>
      /type this address/i.test(s)
    );
    expect(typed).toContain(SHORT_URL);
    expect(typed).not.toContain("token=");
  });

  it("still offers the full link for anyone who can paste", () => {
    const res = builtinSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.steps.some((s) => s.includes(DOWNLOAD_URL))).toBe(true);
  });

  it("falls back to the full link when there is no short one", () => {
    const res = builtinSteps({}, DOWNLOAD_URL, "");
    expect(res.steps.some((s) => s.includes(DOWNLOAD_URL))).toBe(true);
    // No duplicate "if you can paste" tail when both URLs are the same one.
    expect(res.steps.filter((s) => s.includes(DOWNLOAD_URL))).toHaveLength(1);
  });

  it("sends Fire TV and Google TV to different menus", () => {
    const fire = builtinSteps({ brand: "Amazon", model: "Fire TV Stick 4K" }, DOWNLOAD_URL, SHORT_URL);
    const google = builtinSteps({ brand: "Google", os: "Google TV" }, DOWNLOAD_URL, SHORT_URL);

    expect(fire.steps.join("\n")).toContain("My Fire TV");
    expect(fire.steps.join("\n")).toContain("Install unknown apps");
    expect(fire.steps.join("\n")).not.toContain("Android TV OS build");

    expect(google.steps.join("\n")).toContain("Security & restrictions");
    expect(google.steps.join("\n")).toContain("Android TV OS build");
    expect(google.steps.join("\n")).not.toContain("My Fire TV");
  });

  it("recognises Fire TV from any of the three fields", () => {
    const fromOs = builtinSteps({ os: "Fire OS 7" }, DOWNLOAD_URL, SHORT_URL);
    const fromModel = builtinSteps({ model: "Fire TV Cube" }, DOWNLOAD_URL, SHORT_URL);
    expect(fromOs.steps.join("\n")).toContain("My Fire TV");
    expect(fromModel.steps.join("\n")).toContain("My Fire TV");
  });

  it("gives an older Sony set the plain Android TV menu path", () => {
    const sony = builtinSteps({ brand: "Sony", os: "Android TV 8.0" }, DOWNLOAD_URL, SHORT_URL);
    expect(sony.steps.join("\n")).toContain("Device Preferences");
    expect(sony.steps.join("\n")).toContain("Sony");
  });

  it("says so when the TV cannot run Android apps at all", () => {
    const roku = builtinSteps({ brand: "TCL", os: "Roku TV" }, DOWNLOAD_URL, SHORT_URL);
    expect(roku.steps[0]).toMatch(/only installs apps from its own store/i);
    expect(roku.steps.join("\n")).toContain(SHORT_URL);
  });
});

describe("parseSteps", () => {
  it("strips numbering, bullets and 'Step N:' markers", () => {
    expect(
      parseSteps("1. Open Settings\n2) Choose Apps\n- Turn on Unknown sources\nStep 4: Press Go")
    ).toEqual(["Open Settings", "Choose Apps", "Turn on Unknown sources", "Press Go"]);
  });

  it("keeps only the list when the model wraps it in prose", () => {
    const raw = [
      "Sure! Here are the steps for your Fire TV Stick:",
      "",
      "1. Open Settings",
      "2. Choose My Fire TV",
      "",
      "Let me know if you get stuck.",
    ].join("\n");
    expect(parseSteps(raw)).toEqual(["Open Settings", "Choose My Fire TV"]);
  });

  it("treats plain lines as steps when nothing is numbered", () => {
    expect(parseSteps("Open Settings\nPress Go")).toEqual(["Open Settings", "Press Go"]);
  });

  it("splits a numbered list crammed onto one line", () => {
    expect(parseSteps("1. Open Settings 2. Choose Apps 3. Press Go")).toEqual([
      "Open Settings",
      "Choose Apps",
      "Press Go",
    ]);
  });

  it("drops anything with HTML in it", () => {
    expect(
      parseSteps("1. Open Settings\n2. <script>alert(1)</script>\n3. <b>Press Go</b>\n4. <img src=x onerror=alert(1)>")
    ).toEqual(["Open Settings"]);
  });

  it("keeps menu paths that use a > arrow", () => {
    expect(parseSteps("1. Settings > Apps > Security & restrictions")).toEqual([
      "Settings > Apps > Security & restrictions",
    ]);
  });

  it("drops markdown link syntax and keeps the words", () => {
    expect(parseSteps("1. Install [Downloader](https://evil.example/x) from the store")).toEqual([
      "Install Downloader from the store",
    ]);
    expect(parseSteps("1. Get [Downloader][1] now")).toEqual(["Get Downloader now"]);
  });

  it("rejects javascript: and data: URIs", () => {
    expect(
      parseSteps(
        "1. Open javascript:alert(document.cookie)\n2. Visit data:text/html;base64,AAAA\n3. Try java script:alert(1)\n4. Press Go"
      )
    ).toEqual(["Press Go"]);
  });

  it("does not mistake ordinary words ending in 'data' for a data: URI", () => {
    expect(parseSteps("1. Clear the app's metadata: it is safe to do so")).toEqual([
      "Clear the app's metadata: it is safe to do so",
    ]);
  });

  it("caps the number of steps", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step number ${i + 1}`).join("\n");
    expect(parseSteps(raw)).toHaveLength(MAX_STEPS);
  });

  it("cuts an over-long step short", () => {
    const [step] = parseSteps(`1. ${"a".repeat(1000)}`);
    expect(step).toHaveLength(MAX_STEP_CHARS);
    expect(step.endsWith("…")).toBe(true);
  });

  it("trims blank lines, fences, headings and stray markdown", () => {
    const raw = ["## Steps", "", "```", "1. Open **Settings**", "", "2.   Press   `Go`", "```", ""].join(
      "\n"
    );
    expect(parseSteps(raw)).toEqual(["Open Settings", "Press Go"]);
  });

  it("returns nothing for an empty or unusable reply", () => {
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps("   \n\n\t")).toEqual([]);
    expect(parseSteps("1. .\n2. -")).toEqual([]);
  });
});

describe("enforceKnownUrls", () => {
  it("passes steps that use the address we handed out", () => {
    const steps = [`Type ${SHORT_URL} into the URL box`, "Press Go", "Choose Install"];
    expect(enforceKnownUrls(steps, DOWNLOAD_URL, SHORT_URL)).toEqual(steps);
  });

  it("repairs an address on our host that the model rewrote", () => {
    const steps = [
      "Install Downloader",
      "Type http://192.168.1.50:8080/download/media-box.apk into the box",
      "Choose Install",
    ];
    const out = enforceKnownUrls(steps, DOWNLOAD_URL, SHORT_URL);
    expect(out?.[1]).toBe(`Type ${SHORT_URL} into the box`);
  });

  it("rejects the whole reply when the model points at another host", () => {
    const steps = [
      `Type ${SHORT_URL} into the box`,
      "Or grab it from http://mediabox-downloads.example.com/app.apk",
    ];
    expect(enforceKnownUrls(steps, DOWNLOAD_URL, SHORT_URL)).toBeNull();
  });

  it("rejects a reply that never gives our address", () => {
    expect(enforceKnownUrls(["Open Settings", "Install the app"], DOWNLOAD_URL, SHORT_URL)).toBeNull();
  });

  it("tolerates a mention of the app stores Downloader comes from", () => {
    const steps = [
      "Install Downloader from https://play.google.com/store/apps/details?id=com.esaba.downloader",
      `Type ${SHORT_URL} into the box`,
    ];
    expect(enforceKnownUrls(steps, DOWNLOAD_URL, SHORT_URL)).toEqual(steps);
  });

  it("does not read a filename as a host", () => {
    const steps = [`Type ${SHORT_URL} into the box`, "Wait for media-box.apk to download"];
    expect(enforceKnownUrls(steps, DOWNLOAD_URL, SHORT_URL)).toEqual(steps);
  });
});

describe("deviceSteps", () => {
  beforeEach(() => {
    aiEnabledMock.mockReset();
    chatTextMock.mockReset();
    aiEnabledMock.mockReturnValue(false);
  });

  it("uses the built-in steps, and no network, when no provider is configured", async () => {
    const res = await deviceSteps({ brand: "Amazon" }, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(res.warning).toBeUndefined();
    expect(chatTextMock).not.toHaveBeenCalled();
  });

  it("returns the model's steps when they check out", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockResolvedValue(
      [
        "1. Install the Downloader app from the Amazon Appstore",
        "2. Settings > My Fire TV > Developer options > Install unknown apps, turn on Downloader",
        `3. In Downloader type ${SHORT_URL} and press Go`,
        "4. Choose Install, then Open",
      ].join("\n")
    );

    const res = await deviceSteps({ brand: "Amazon", model: "Fire TV Stick 4K" }, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("ai");
    expect(res.warning).toBeUndefined();
    expect(res.steps).toHaveLength(4);
    expect(res.steps[2]).toContain(SHORT_URL);

    const [system, user, opts] = chatTextMock.mock.calls[0];
    expect(system).toMatch(/numbered steps only/i);
    expect(user).toContain(SHORT_URL);
    expect(user).toContain("Fire TV Stick 4K");
    expect(opts?.timeoutMs).toBeGreaterThan(0);
    expect(opts?.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("repairs an address the model rewrote on our own host", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockResolvedValue(
      [
        "1. Install Downloader",
        "2. Type http://192.168.1.50:8080/apps/android into the URL box",
        "3. Choose Install",
      ].join("\n")
    );

    const res = await deviceSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("ai");
    expect(res.steps[1]).toContain(SHORT_URL);
    expect(res.steps[1]).not.toContain("/apps/android");
  });

  it("falls back when the model substitutes a different download host", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockResolvedValue(
      [
        "1. Install Downloader",
        "2. Type http://media-box-apk.example.net/latest.apk into the URL box",
        "3. Choose Install",
      ].join("\n")
    );

    const res = await deviceSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(res.warning).toMatch(/download address/i);
    expect(res.steps.join("\n")).not.toContain("example.net");
    expect(res.steps.join("\n")).toContain(SHORT_URL);
  });

  it("falls back when the reply is not steps at all", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockResolvedValue("I'm sorry, I can't help with sideloading.");

    const res = await deviceSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(res.warning).toMatch(/didn't look like install steps/i);
  });

  it("falls back, with the reason, when the call fails", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockRejectedValue(new Error("Ollama (http://localhost:11434) responded 500"));

    const res = await deviceSteps({ os: "Google TV" }, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(res.warning).toContain("500");
    expect(res.steps.join("\n")).toContain("Security & restrictions");
  });

  it("never throws, even when the provider check itself blows up", async () => {
    aiEnabledMock.mockImplementation(() => {
      throw new Error("settings unreadable");
    });

    const res = await deviceSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("builtin");
    expect(chatTextMock).not.toHaveBeenCalled();
  });

  it("strips markup out of the model's steps before returning them", async () => {
    aiEnabledMock.mockReturnValue(true);
    chatTextMock.mockResolvedValue(
      [
        "Here you go:",
        "1. Install **Downloader** from the store",
        "2. <img src=x onerror=alert(1)>",
        "3. Turn on Unknown sources for Downloader",
        `4. Type ${SHORT_URL} and press Go`,
        "5. Choose [Install](javascript:alert(1))",
      ].join("\n")
    );

    const res = await deviceSteps({}, DOWNLOAD_URL, SHORT_URL);
    expect(res.source).toBe("ai");
    expect(res.steps).toEqual([
      "Install Downloader from the store",
      "Turn on Unknown sources for Downloader",
      `Type ${SHORT_URL} and press Go`,
    ]);
  });
});

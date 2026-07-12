import { describe, expect, it } from "vitest";
import { contentTypeFor } from "./file-stream";

describe("contentTypeFor", () => {
  it("serves both MP4 extensions with the browser-standard MIME type", () => {
    expect(contentTypeFor("movie.mp4")).toBe("video/mp4");
    expect(contentTypeFor("movie.M4V")).toBe("video/mp4");
  });

  it("keeps container-specific types and safely falls back", () => {
    expect(contentTypeFor("episode.mkv")).toBe("video/x-matroska");
    expect(contentTypeFor("clip.webm")).toBe("video/webm");
    expect(contentTypeFor("disc.vob")).toBe("application/octet-stream");
  });
});

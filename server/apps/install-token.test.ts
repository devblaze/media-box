import { beforeEach, describe, expect, test, vi } from "vitest";

// The signing secret is the app's API key, which lives behind the settings
// service and its database. A fixed key here keeps the tests to the crypto.
let apiKey = "test-api-key";
vi.mock("@/server/settings/settings-service", () => ({
  getSettings: () => ({ apiKey }),
}));

import {
  mintInstallToken,
  verifyInstallToken,
  mintShortCode,
  resolveShortCode,
} from "./install-token";

beforeEach(() => {
  apiKey = "test-api-key";
  vi.useRealTimers();
});

describe("install tokens", () => {
  test("a freshly minted token names the build it was minted for", () => {
    const token = mintInstallToken("build-1");
    expect(verifyInstallToken(token)).toBe("build-1");
  });

  test("a token for one build does not authorise another", () => {
    // The download route compares the verified id against the build being asked
    // for, so this is the property that stops one link fetching every build.
    expect(verifyInstallToken(mintInstallToken("build-1"))).not.toBe("build-2");
  });

  test("tampering with the build id invalidates the signature", () => {
    const [, exp, sig] = mintInstallToken("build-1").split(".");
    expect(verifyInstallToken(`build-2.${exp}.${sig}`)).toBeNull();
  });

  test("extending the expiry invalidates the signature", () => {
    // The expiry is inside the signed payload precisely so it can't be edited.
    const [id, exp, sig] = mintInstallToken("build-1").split(".");
    expect(verifyInstallToken(`${id}.${Number(exp) + 60_000}.${sig}`)).toBeNull();
  });

  test("an expired token is refused even though it is properly signed", () => {
    const token = mintInstallToken("build-1", -1);
    expect(verifyInstallToken(token)).toBeNull();
  });

  test("malformed tokens are refused rather than throwing", () => {
    for (const bad of ["", "nonsense", "a.b", "a.b.c.d", "..", "build-1.123."]) {
      expect(verifyInstallToken(bad)).toBeNull();
    }
  });

  test("rotating the API key invalidates outstanding links", () => {
    // Documented behaviour: an admin who rotates the key expects every install
    // link they have handed out to stop working.
    const token = mintInstallToken("build-1");
    apiKey = "rotated";
    expect(verifyInstallToken(token)).toBeNull();
  });
});

describe("short codes", () => {
  test("a code resolves to its build", () => {
    const { code } = mintShortCode("build-9");
    expect(resolveShortCode(code)).toBe("build-9");
  });

  test("codes avoid characters that read as each other on a TV screen", () => {
    // I, L, O and U are excluded so nobody types a 1 for an I or a 0 for an O.
    for (let i = 0; i < 50; i++) {
      expect(mintShortCode("b").code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    }
  });

  test("resolution forgives the case and spacing of something typed by remote", () => {
    const { code } = mintShortCode("build-9");
    expect(resolveShortCode(` ${code.toLowerCase()} `)).toBe("build-9");
  });

  test("an unknown code resolves to nothing", () => {
    expect(resolveShortCode("ZZZZZZ")).toBeNull();
  });

  test("a code stops working once it expires", () => {
    const { code } = mintShortCode("build-9", -1);
    expect(resolveShortCode(code)).toBeNull();
  });
});

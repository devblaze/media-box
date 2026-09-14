import { describe, expect, test } from "vitest";
import {
  AdbCommandError,
  DEFAULT_ADB_PORT,
  adbAvailable,
  adbFailureReason,
  buildConnectArgs,
  buildDisconnectArgs,
  buildInstallArgs,
  buildPairArgs,
  deviceSerial,
  installApk,
  isValidHost,
} from "./adb";

const HOST = "192.168.1.50";
const APK = "/config/apps/9f2c1a.apk";

describe("argv construction", () => {
  test("connect targets host:port, default port 5555", () => {
    expect(DEFAULT_ADB_PORT).toBe(5555);
    expect(buildConnectArgs(HOST, DEFAULT_ADB_PORT)).toEqual(["connect", "192.168.1.50:5555"]);
    expect(buildConnectArgs("androidtv.local", 5556)).toEqual(["connect", "androidtv.local:5556"]);
  });

  test("install names the device, reinstalls in place, and ends with the APK path", () => {
    const serial = deviceSerial(HOST, DEFAULT_ADB_PORT);
    expect(serial).toBe("192.168.1.50:5555");
    const args = buildInstallArgs(serial, APK);
    expect(args).toEqual(["-s", serial, "install", "-r", APK]);
    // `-s` is a GLOBAL option: after the subcommand it means something else.
    expect(args.indexOf("-s")).toBeLessThan(args.indexOf("install"));
    // `-r` (reinstall, keep data) is what makes an upgrade of an already
    // installed build work instead of INSTALL_FAILED_ALREADY_EXISTS.
    expect(args).toContain("-r");
    expect(args[args.length - 1]).toBe(APK);
  });

  test("pair uses its own ephemeral port and passes the code as one argument", () => {
    expect(buildPairArgs(HOST, 37419, "123456")).toEqual(["pair", "192.168.1.50:37419", "123456"]);
    // The pairing port is NOT the adb port — a pair on 5555 would never work.
    expect(buildPairArgs(HOST, 37419, "123456")[1]).not.toContain(String(DEFAULT_ADB_PORT));
  });

  test("disconnect addresses the same serial connect produced", () => {
    const serial = deviceSerial(HOST, DEFAULT_ADB_PORT);
    expect(buildDisconnectArgs(serial)).toEqual(["disconnect", serial]);
    expect(buildConnectArgs(HOST, DEFAULT_ADB_PORT)[1]).toBe(serial);
  });

  test("builders quote nothing — these are argv arrays, not shell strings", () => {
    // Whatever is in the value stays exactly one argument, so there is nothing
    // for a shell to split or re-interpret. (isValidHost keeps such a value from
    // ever reaching a builder in the first place; this pins down the contract.)
    const args = buildConnectArgs("a b; rm -rf /", 5555);
    expect(args).toHaveLength(2);
    expect(args[1]).toBe("a b; rm -rf /:5555");
    expect(buildInstallArgs("s", "/apps/my app.apk")).toHaveLength(5);
  });
});

describe("isValidHost", () => {
  test("accepts IPv4 literals and plain hostnames", () => {
    for (const host of [
      "192.168.1.50",
      "10.0.0.2",
      "androidtv.local",
      "shield",
      "living-room-tv.lan",
      "0.0.0.0",
      "255.255.255.255",
    ]) {
      expect(isValidHost(host), host).toBe(true);
    }
  });

  test("rejects hostile or malformed input", () => {
    for (const host of [
      "1.2.3.4; rm -rf /", // command chaining
      "1.2.3.4 && reboot",
      "$(whoami)",
      "`id`",
      "host|nc 1.2.3.4 1",
      "--help", // adb would read a leading dash as an option
      "-s",
      "host name", // whitespace
      "host\tname",
      "host\nconnect", // embedded newline
      "http://1.2.3.4", // scheme
      "1.2.3.4:5555", // embedded port would override the one we append
      "androidtv.local:5555",
      "../x", // path traversal / separators
      "/dev/null",
      "a/b",
      "", // empty
      " ",
      "..",
      "host..name", // empty label
      ".leading.dot",
      "trailing.dot.",
      "-leading.dash",
      "trailing-.dash",
      "under_score",
      "999.1.1.1", // digits-and-dots that is not a valid IPv4
      "10.0.0",
      "1.2.3.4.5",
      "256.1.1.1",
      `${"a".repeat(64)}.local`, // label over 63 chars
      `${"a.".repeat(200)}local`, // name over 253 chars
    ]) {
      expect(isValidHost(host), JSON.stringify(host)).toBe(false);
    }
  });
});

describe("adbFailureReason", () => {
  test("catches the connect failures adb reports while exiting 0", () => {
    // The whole point of reading the output: these exit 0 on many adb builds.
    expect(adbFailureReason("failed to connect to '10.0.0.2:5555': Connection refused")).toBe(
      "failed to connect to '10.0.0.2:5555': Connection refused"
    );
    expect(adbFailureReason("unable to connect to 10.0.0.2:5555")).toBeTruthy();
    expect(adbFailureReason("cannot connect to 10.0.0.2:5555: No route to host")).toBeTruthy();
    expect(adbFailureReason("failed to authenticate to 10.0.0.2:5555")).toBeTruthy();
  });

  test("catches install failures and returns the reason line verbatim", () => {
    const out = "Performing Streamed Install\nFailure [INSTALL_FAILED_INSUFFICIENT_STORAGE]";
    expect(adbFailureReason(out)).toBe("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]");
    expect(
      adbFailureReason("adb: failed to install app.apk: Failure [INSTALL_FAILED_OLDER_SDK]")
    ).toContain("INSTALL_FAILED_OLDER_SDK");
    expect(adbFailureReason("adb: error: device unauthorized.")).toBeTruthy();
    expect(adbFailureReason("error: device offline")).toBe("error: device offline");
    expect(adbFailureReason("error: more than one device/emulator")).toBeTruthy();
  });

  test("catches a refused pairing", () => {
    expect(adbFailureReason("Failed: Wrong password")).toBe("Failed: Wrong password");
    expect(
      adbFailureReason("Enter pairing code: Failed: protocol fault (couldn't read status)")
    ).toBeTruthy();
  });

  test("returns the FIRST failing line, so the cause beats the consequence", () => {
    const out = ["Performing Streamed Install", "Failure [INSTALL_FAILED_TEST_ONLY]", "error: closed"].join(
      "\n"
    );
    expect(adbFailureReason(out)).toBe("Failure [INSTALL_FAILED_TEST_ONLY]");
  });

  test("success and daemon noise are not failures", () => {
    expect(adbFailureReason("")).toBeNull();
    expect(adbFailureReason("   \n  \n")).toBeNull();
    expect(adbFailureReason("connected to 10.0.0.2:5555")).toBeNull();
    expect(adbFailureReason("already connected to 10.0.0.2:5555")).toBeNull();
    expect(adbFailureReason("Successfully paired to 10.0.0.2:37419 [guid=adb-xyz]")).toBeNull();
    expect(adbFailureReason("Performing Streamed Install\nSuccess")).toBeNull();
    expect(adbFailureReason("disconnected 10.0.0.2:5555")).toBeNull();
    // The cold-start banner adb writes to stderr must never read as a failure.
    expect(
      adbFailureReason(
        "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nconnected to 10.0.0.2:5555"
      )
    ).toBeNull();
  });

  test("detection is case-insensitive", () => {
    expect(adbFailureReason("FAILED TO CONNECT TO '10.0.0.2:5555'")).toBeTruthy();
    expect(adbFailureReason("Error: Device Offline")).toBeTruthy();
  });
});

describe("installApk input validation", () => {
  // These reject before anything is spawned, so they need no adb and no device.
  test("a hostile host is refused without running anything", async () => {
    for (const host of ["1.2.3.4; rm -rf /", "--help", "host name", "http://1.2.3.4", "1.2.3.4:5555", "../x", ""]) {
      await expect(installApk({ host, apkPath: APK }), host).rejects.toThrow(AdbCommandError);
    }
  });

  test("a bad port, pairing port or pairing code is refused", async () => {
    await expect(installApk({ host: HOST, port: 0, apkPath: APK })).rejects.toThrow(/port/i);
    await expect(installApk({ host: HOST, port: 99999, apkPath: APK })).rejects.toThrow(/port/i);
    await expect(
      installApk({ host: HOST, apkPath: APK, pairPort: 37419, pairCode: "abcdef" })
    ).rejects.toThrow(/six digits/i);
    await expect(
      installApk({ host: HOST, apkPath: APK, pairPort: 37419, pairCode: "--help" })
    ).rejects.toThrow(/six digits/i);
    // A pairing code without its port (or vice versa) is a half-filled form.
    await expect(installApk({ host: HOST, apkPath: APK, pairCode: "123456" })).rejects.toThrow(
      /pairing port/i
    );
  });

  test("the rejection never echoes the address back at the UI", async () => {
    const hostile = "1.2.3.4; rm -rf /";
    await expect(installApk({ host: hostile, apkPath: APK })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("rm -rf") })
    );
  });
});

describe("adbAvailable", () => {
  test("answers with a boolean and never throws, adb installed or not", async () => {
    await expect(adbAvailable()).resolves.toBeTypeOf("boolean");
  });
});

import { ok } from "@/lib/http";
import { CONFIG_DIR } from "@/server/config/paths";

const startedAt = new Date();

export async function GET() {
  return ok({
    appName: "media-box",
    version: process.env.npm_package_version ?? "0.1.0",
    startedAt: startedAt.toISOString(),
    configDir: CONFIG_DIR,
    node: process.version,
  });
}

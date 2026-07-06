import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "image.tmdb.org" }],
  },
  // Expose the package.json version to the app (single source of truth) so the
  // UI can show which build is running. Inlined at build time.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
};

export default nextConfig;

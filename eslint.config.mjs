import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The React Native / Expo app is a separate project with its own toolchain.
    "apps/**",
  ]),
  {
    rules: {
      // `const { rank: _rank, ...rest } = x` is how a field gets dropped — the
      // omitted sibling isn't dead code. `_`-prefixed names are deliberate too.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Pre-existing react-hooks findings, from before these rules shipped. They
    // are warnings HERE ONLY so CI can fail on the rule everywhere else — fixing
    // one means deleting its path from this list, and new files never get in.
    files: [
      "app/(app)/account/page.tsx",
      // NB: a literal "[id]" would be read as a glob character class.
      "app/(app)/series/*/page.tsx",
      "app/(app)/settings/general/page.tsx",
      "app/(app)/settings/jellyfin/page.tsx",
      "app/(app)/settings/library-import/page.tsx",
      "app/(app)/settings/media-management/page.tsx",
      "app/(app)/settings/migrate/page.tsx",
      "components/admin-panel.tsx",
      "components/channel-player.tsx",
      "components/library-import-row.tsx",
      "components/media-player.tsx",
      "components/netflix/hero-billboard.tsx",
      "components/netflix/search-context.tsx",
      "components/subtitle-search.tsx",
      "components/ui/toast.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;

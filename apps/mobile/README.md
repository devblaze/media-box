# Media Box — mobile & TV app

An [Expo](https://expo.dev) (React Native) client for a self-hosted **media-box**
server. One TypeScript codebase targets **iPhone, Android, Android TV, and Apple
TV**; it talks to the same REST API as the web app (`/api/v1/**`).

## What's here (v1 foundation)

The first vertical slice, iPhone-first:

- **Onboarding** (`src/app/onboarding.tsx`) — enter your server's address (the same
  URL you open media-box at in a browser). It's health-checked against
  `GET /api/v1/health` before it's saved.
- **Login** (`src/app/login.tsx`) — `POST /api/v1/auth/login`; the session cookie is
  kept by the platform cookie store.
- **Browse** (`src/app/browse.tsx`) — rows of posters from `GET /api/v1/discover`
  (Recently Added, Trending, Popular Movies/Series/Anime).

The entry gate (`src/app/index.tsx`) routes to the right screen based on what's
stored: no server → onboarding, server but no session → login, both → browse.

### Layout

```
src/
  app/            expo-router routes (_layout, index, onboarding, login, browse)
  components/     poster-row (horizontal poster list)
  lib/            api (REST client), config (server + auth context), storage, theme
```

## Run it

Prerequisites: Node 20+, and the [Expo Go](https://expo.dev/go) app on your phone
(or Xcode / Android Studio for simulators).

```bash
cd apps/mobile
npm install          # already done if you cloned with node_modules
npx expo start       # then press i (iOS sim), a (Android), or scan the QR in Expo Go
```

On first launch enter your server address, e.g. `http://192.168.1.10:7878`.

> **Local HTTP:** the app is configured to allow cleartext/local-network traffic
> (`ios.infoPlist.NSAppTransportSecurity`, `android.usesCleartextTraffic`) because
> self-hosted servers are usually plain HTTP on a LAN.

## Installable builds (APK, stores, TestFlight)

`npx expo start` and the web export are enough for development, but the media-box
server hands out a **real, installable Android APK** behind a QR code. That APK comes
from [EAS Build](https://docs.expo.dev/build/introduction/), configured in
[`eas.json`](eas.json).

### What the Expo account is for

EAS Build is a hosted service — the build runs on Expo's machines, not yours:

- `eas login` authenticates you. A free Expo account can produce builds (they queue,
  and usage limits apply — see [expo.dev/pricing](https://expo.dev/pricing)).
- `eas init` links this directory to an EAS project and writes the project id into
  `app.json` (`extra.eas.projectId`). Once, ever.
- Expo generates and **keeps the Android signing keystore**, so every APK you ship is
  signed with the same key and installs as an in-place upgrade over the last one.
  `eas.json` sets `"appVersionSource": "remote"`, which means EAS owns
  `android.versionCode` and bumps it on each `selfhosted` build — Android refuses an
  upgrade whose versionCode did not go up.

No Google Play account is needed for this path; Play ($25 once) only matters for the
`production` (AAB) profile.

### Build the self-hosted APK

```bash
npm i -g eas-cli
cd apps/mobile
eas login
eas init             # once — links the project
npm run build-apk    # eas build --platform android --profile selfhosted
```

The `selfhosted` profile is `"distribution": "internal"` plus
`"android": { "buildType": "apk" }` — `buildType: "apk"` is the field that produces a
directly installable `.apk` instead of a Play-only `.aab`.

When the build finishes the CLI prints a download URL, and the build's page on
[expo.dev](https://expo.dev) has a **Download** button (and its own install QR). To
find an older one:

```bash
eas build:list --platform android --limit 5     # add --json for artifact URLs
```

To keep everything on your own hardware, the same profile runs locally if you have an
Android SDK/JDK toolchain (still needs `eas login`; macOS/Linux only, no caching, and
`node`/`image`/`ndk` fields in `eas.json` are ignored):

```bash
npm run build-apk-local     # → apps/mobile/build/media-box.apk
```

### Hand it to the server

Upload the `.apk` in media-box under **Settings**. The server hosts the file and shows
the install QR, so a phone on the LAN installs straight from your box — Android will
ask the user to allow installs from that source, since it did not come from Play.

### The other profiles

| Profile | What it produces | Command |
| --- | --- | --- |
| `selfhosted` | signed release **APK** for the server to hand out | `npm run build-apk` |
| `preview` | internal test build — APK on Android, **Simulator** build on iOS | `eas build --platform android --profile preview` |
| `development` | debug build with the dev client, Simulator on iOS | `npm run build-dev` |
| `production` | store artifacts — Android **AAB**, iOS App Store archive | `npm run build-android` / `npm run build-ios` |

> The profile flag is `--profile`, short form `-e` (not `-p`, which is `--platform`).

> **`development` needs one extra package.** A `"developmentClient": true` build
> requires `npx expo install expo-dev-client`, which this project does not depend on
> yet — install it before using that profile. The app runs in Expo Go without it.

### iOS is not symmetric — there is no APK equivalent

Apple has no "download a file and install it" story, so the QR flow above is
Android-only. For iPhone/iPad the options are:

- **A paid Apple Developer Program membership ($99/yr)** for anything that runs on a
  real device. A free account only covers the Simulator — which is what `preview` and
  `development` produce, via `"ios": { "simulator": true }`.
- **Ad hoc distribution.** `"distribution": "internal"` on iOS builds an ad hoc
  provisioning profile holding an allow-list of device **UDIDs**: at most **100 iPhones
  per membership year**, each device registered with `eas device:create` *before* the
  build. A device added later needs the build rebuilt or re-signed. (`eas device:list`,
  `eas device:delete` to manage them.)
- **TestFlight** — the only practical route past 100 devices, via an App Store Connect
  upload and Apple's review for external testers.

The Apple Developer Enterprise Program drops the device limit, but it is a separate,
restricted membership — not something a self-hoster should plan around.

**tvOS has no sideloading path at all.** An Apple TV app can only arrive through the
App Store or TestFlight, and tvOS needs its own provisioning profiles, separate from
the iOS ones. The media-box server will never be able to hand out an Apple TV build.

### Android TV: the config is not ready

The `selfhosted` APK will `adb install` onto an Android TV box, but this is **not an
Android TV app** yet. Today `app.json`:

- declares **no leanback launcher intent**
  (`android.intent.category.LEANBACK_LAUNCHER`), so the app never shows up on the TV
  home screen or launcher;
- declares **no `uses-feature` flags** — neither `android.software.leanback` nor
  `android.hardware.touchscreen` with `required: false` — so Play would filter it off
  TV devices entirely;
- ships **no TV banner** asset (`assets/images/` has phone icons and a splash only).

What is already fine: `"orientation": "default"` pins nothing to portrait. What is not:
`package.json` uses stock `react-native` (`0.85.3`), not the TV fork, and nothing in
`src/` handles D-pad focus.

A proper Android TV build would need, per
[Building for TV](https://docs.expo.dev/guides/building-for-tv/):

1. `"react-native": "npm:react-native-tvos@0.85-stable"` — the fork matching SDK 56's
   React Native 0.85;
2. `@react-native-tvos/config-tv` as a dev dependency, added to `expo.plugins`; that
   config plugin is what rewrites `AndroidManifest.xml` for TV during prebuild;
3. `EXPO_TV=1` in the build environment — on EAS, a dedicated profile with
   `"env": { "EXPO_TV": "1" }`. Deliberately **not** in `eas.json` yet, because it
   changes what an Android build means for everyone.
4. 10-foot UI work in `src/` — D-pad focus order and focus-visible styling.

Until that lands, treat the APK as phone/tablet only.

## Roadmap

- **Playback** — video screen via `expo-video` against `/api/v1/stream/*`.
- **Detail screens** — movie/series pages, request unavailable titles.
- **Apple TV / Android TV** — the same codebase with `react-native-tvos` + 10-foot
  (D-pad/focus) layouts.
- **Samsung (Tizen) / LG (webOS)** — a separate small web app that reuses `lib/api`.

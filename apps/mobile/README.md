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

## Building for the stores (your step)

Native builds and store submission need **your** developer accounts + signing,
done via [EAS Build](https://docs.expo.dev/build/introduction/):

```bash
npm i -g eas-cli && eas build --platform ios      # or android
```

Apple Developer Program ($99/yr) for iOS/tvOS; Google Play ($25 once) for Android.

## Roadmap

- **Playback** — video screen via `expo-video` against `/api/v1/stream/*`.
- **Detail screens** — movie/series pages, request unavailable titles.
- **Apple TV / Android TV** — the same codebase with `react-native-tvos` + 10-foot
  (D-pad/focus) layouts.
- **Samsung (Tizen) / LG (webOS)** — a separate small web app that reuses `lib/api`.

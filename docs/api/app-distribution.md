# App Distribution (self-hosted app builds)

REST reference for the endpoints that let media-box hand out its own mobile app builds, so a phone or TV installs the app from the same box that holds the library instead of from an app store. It covers uploading/listing/deleting builds, the tokenised download and the iOS install manifest, minting a QR link and a short code, pushing an APK to an Android TV over adb, and the per-device sideloading steps.

**Auth.** Every request is authenticated by a session cookie **or** an `x-api-key: <apiKey>` header (an API key is treated as an admin). Guards used below:

- **Admin** — `requireAdmin` in the handler; a non-admin session gets `403`, an unauthenticated request `401`.
- **User** — `requireUser` in the handler (any authenticated principal); unauthenticated gets `401`.
- **Session or install token** — `GET /apps/{id}/{file}` only: a session/API key, **or** a signed `?token=` naming that build.

**Install tokens.** A phone scanning the QR code has no account on this server — getting the app is the thing it is trying to do — so the download cannot sit behind a session. Each install link instead carries a signed, expiring token, and a TV (no camera, miserable keyboard) gets a short code that stands in for one. What that means in practice:

- A token is `<buildId>.<expiryEpochMs>.<HMAC-SHA256, base64url>`. `verifyInstallToken` compares the signature in constant time and rejects anything malformed, forged, or past its expiry. The download route additionally requires that the build the token names is the build in the path, so a token for one build cannot fetch another.
- **A token lives 30 minutes** (`INSTALL_TOKEN_TTL_MS`), and so does the short code minted beside it.
- **The signing secret is the server's API key** (`settings.apiKey`). Rotating the API key therefore invalidates every outstanding install link, QR code and manifest in one stroke — which is the behaviour an admin would expect, but also means a rotation breaks an install someone is halfway through.
- **Short codes** are six characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I/L/O/U, so nothing reads as a digit), looked up case- and whitespace-insensitively because they are typed on a remote. They live **in memory only**: a restart invalidates every outstanding code. Tokens are signed rather than stored, so they survive a restart.
- `proxy.ts` lets an anonymous request reach `/api/v1/apps/*` whenever a `token=` query param is present. That is the edge opening a door, not authentication — the proxy runtime has no DB access and cannot verify a signature. `GET /apps/{id}/{file}` is the only handler that actually accepts a token; every other `/apps` route still runs its own `requireUser`/`requireAdmin` guard and answers a token-bearing anonymous request with `401`.
- The two public pages `/get/<token>` and `/apk/<code>` are likewise exempt from the proxy's login redirect (`PUBLIC_PAGES`). They are documented at the end of this page.

> **`catalog.json` is coarser than this page for these routes.** Its auth detection is per *file*, not per method, so `GET /api/v1/apps` is recorded as `admin` because the `POST` in the same file calls `requireAdmin` — the `GET` really is `requireUser`. And `GET /api/v1/apps/{id}/{file}` is recorded as `session` because it checks `getRequestUser` directly; it also accepts an unauthenticated request carrying a valid `?token=`. The per-endpoint sections below are authoritative.

Standard JSON error envelope is `{ "error": "..." }` (Zod failures raised through `serverError` add `{ "error": "Validation failed", "issues": [...] }`). Status codes: `200` ok, `201` created, `400` bad request, `401` unauthenticated, `403` forbidden, `404` not found, `413` build too large, `502` adb ran and failed, `503` adb not installed, `500` server error. The download/manifest route is the exception: it answers in **plain text**, not JSON.

Examples assume `MEDIABOX_URL` and `MEDIABOX_API_KEY` are set.

---

## `GET /api/v1/apps`

Every build this server hands out, plus everything the "Get the app" page needs to explain itself: the address a phone should use, and which install routes are actually open on this deployment.

- **Auth:** User.
- **Response:** `200` —
  ```json
  {
    "builds": [
      {
        "id": "9f3c2a1b4d5e6f70",
        "platform": "android",
        "version": "1.0.0",
        "sizeBytes": 62914560,
        "sha256": "4f2c…",
        "uploadedAt": "2026-09-14T10:12:00.000Z",
        "bundleId": "org.example.mediabox",
        "notes": "ad-hoc, 3 devices"
      }
    ],
    "address": {
      "baseUrl": "http://192.168.1.10:7878",
      "source": "request",
      "https": false,
      "candidates": ["http://192.168.1.10:7878", "http://172.17.0.2:7878"]
    },
    "capabilities": { "adb": true, "ai": false, "iosInstallable": false, "https": false },
    "testflightUrl": "",
    "maxBuildBytes": 536870912
  }
  ```
  `builds` is newest upload first; `bundleId` and `notes` are absent when they were never supplied. `testflightUrl` echoes the `appTestflightUrl` setting and `maxBuildBytes` is the upload cap (512 MB). Errors: `401`, `500`.

- **`address` — where links point.** Everything this feature hands out is a URL that has to work from a *different* device, so a QR code encoding `http://localhost:7878/get/…` is a picture that installs nothing. `resolveServerAddress` picks an origin in order of how much it can be trusted, and reports which rule fired:

  | `source` | when | `baseUrl` | `https` |
  | --- | --- | --- | --- |
  | `setting` | `appDownloadBaseUrl` is set and parses as a URL | that URL's origin | its scheme is `https:` |
  | `request` | no setting, and `x-forwarded-host` (else `Host`) is **not** a loopback name | `<x-forwarded-proto, first value, else http>://<that host>` | the forwarded proto is `https` |
  | `interface` | the admin is browsing on `localhost` / `127.x` / `::1`, so the Host header is no use to a phone | `http://<first LAN IPv4 of this host>:<PORT, default 7878>` | always `false` |
  | `fallback` | none of the above, and this process can see no usable interface either | the Host-derived origin if there is one, else `http://localhost:<PORT>` | the forwarded proto is `https` |

  `candidates` is every non-internal IPv4 this process can see, rendered as `http://<ip>:<PORT>`, with RFC 1918 ranges (`192.168/16`, `10/8`, `172.16/12`) sorted first — the UI offers them as alternatives. The scheme is only ever knowable from `x-forwarded-proto`: inside the container the connection is plain HTTP even when TLS was terminated outside, which is why an HTTPS deployment behind a proxy that strips that header reports `https: false` and disables the iOS flow.

  **Docker caveat.** Inside Docker's default bridge network the only interfaces this process can see are the container's (`172.17.x.x`), which no phone on the LAN can reach — so `candidates`, and an `interface`-sourced `baseUrl`, are wrong there. The fix is the `appDownloadBaseUrl` setting: point it at the host's real LAN origin (or at the public HTTPS origin of a reverse proxy) and every link, QR code and manifest is minted from that instead.

- **`capabilities` — what this deployment can actually do.**

  | field | meaning |
  | --- | --- |
  | `adb` | `adb version` runs on the server, so `POST /apps/tv/install` has a chance of working. The published Docker image installs `adb`; a bare host without platform-tools reports `false`. |
  | `ai` | an AI provider is configured (`aiProvider` plus its credentials), so `POST /apps/tv/instructions` can write device-specific steps instead of the built-in ones. |
  | `iosInstallable` | there is at least one iOS build **and** `address.https` — iOS refuses an `itms-services` install over anything but trusted HTTPS. (It does not also check the build's `bundleId`, which the `/get/<token>` page does; upload rejects an iOS build without one, so the two only disagree for a hand-edited catalog.) |
  | `https` | mirrors `address.https`. |

- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/apps" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/apps`

Upload a build. **The metadata rides in the query string and the binary IS the body** — an APK is tens of megabytes, and multipart would mean buffering the whole thing in memory to parse one field out of it. The body is streamed to disk, hashed and measured as it goes; nothing is ever held whole.

- **Auth:** Admin.
- **Query params:** (this is the request "body table" — these are not JSON fields)

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `platform` | `android` \| `ios` | yes | fixes the stored extension (`.apk` / `.ipa`) and the download `Content-Type`. |
  | `version` | string, 1–64 chars | yes | marketing version as the uploader labels it (e.g. `1.0.0`). Shown to the installer and used to build the download filename. |
  | `bundleId` | string, ≤ 255 chars | **iOS only, required there** | the IPA's real bundle identifier. The `itms-services` manifest has to advertise it or the install fails with no useful error. Ignored-but-stored for Android. |
  | `notes` | string, ≤ 500 chars | no | free text, e.g. which devices an ad-hoc build covers. |

- **Request body:** the raw bytes of the `.apk` / `.ipa`. Not multipart, not JSON; the `Content-Type` header is not inspected.
- **Storage:** the file lands at `<CONFIG_DIR>/apps/<random 16-hex id>.<apk|ipa>` with a `catalog.json` beside it. The id — never anything the uploader typed — is the filename, so an upload can't choose where it lands. A failed or oversized upload removes the partial file and writes no catalog entry.
- **Response:** `201` — the new catalog entry (same shape as an element of `builds` above). Errors:
  - `400` `Invalid upload metadata` (query string failed Zod),
  - `400` `An iOS build needs its bundle identifier — the install manifest carries it`,
  - `400` `Missing request body`,
  - `401` / `403`,
  - `413` `Build exceeds the 512 MB limit` (`MAX_BUILD_BYTES`, also reported as `maxBuildBytes`),
  - `500`.
- **Example:**
  ```bash
  curl -sS -X POST \
    "$MEDIABOX_URL/api/v1/apps?platform=android&version=1.0.0&notes=nightly" \
    -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "content-type: application/octet-stream" \
    --data-binary @media-box-1.0.0.apk
  ```
  iOS, where the bundle id is mandatory:
  ```bash
  curl -sS -X POST \
    "$MEDIABOX_URL/api/v1/apps?platform=ios&version=1.0.0&bundleId=org.example.mediabox" \
    -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "content-type: application/octet-stream" \
    --data-binary @MediaBox.ipa
  ```

---

## `DELETE /api/v1/apps/[id]`

Remove a build: its catalog entry and its file on disk.

- **Auth:** Admin.
- **Path params:** `id` — build id.
- **Response:** `200` — `{ "deleted": true }`. A JSON body rather than a bare `204`, because the shared `apiFetch` always reads one and every other `DELETE` in this API answers the same way. Unlike the transcode teardown this is **not** idempotent from the caller's point of view: an unknown id is a `404`. Errors: `401` / `403`, `404` `{ "error": "Build not found" }`.
- **Outstanding links:** deleting a build does not revoke its tokens directly, but the download route resolves the build first, so every link for it starts answering `404` immediately.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/apps/9f3c2a1b4d5e6f70" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/apps/[id]/[file]`

Serve a build, or the iOS install manifest that points at one. This is the one route in the area that a device with no account can call.

- **Auth:** Session / API key, **or** a valid `?token=` whose build id equals the `id` in the path. Neither → `401` `Unauthorized` (plain text).
- **Path params:** `id` — build id; `file` — must be exactly `download` or `manifest.plist`. That two-name whitelist **is** the path-traversal defence (same pattern as the transcode segment route); anything else → `400` `Bad Request` (plain text).
- **Query params:** `token` — an install token from `POST /apps/link` (or minted for you by `/apk/<code>`). Only needed when there is no session.
- **Response — `download`:** `200`, the binary streamed from disk.
  - `Content-Type: application/vnd.android.package-archive` (android) or `application/octet-stream` (ios).
  - `Content-Length`, `Cache-Control: no-store`.
  - `Content-Disposition: attachment; filename="media-box-<version>-<platform>.<apk|ipa>"` — rebuilt from catalog fields with everything outside `[A-Za-z0-9._-]` stripped from the version, so nothing anyone typed can split the header.
  - No `Range` support: the whole file, every time.
- **Response — `manifest.plist`:** `200`, `Content-Type: application/xml`, `Cache-Control: no-store`. The property list iOS fetches when it follows an `itms-services://` link: one `software-package` asset URL, plus `bundle-identifier` (the build's `bundleId`), `bundle-version` (its `version`), `kind` `software` and `title` `Media Box`. Every interpolated value is XML-escaped — the version and bundle id are admin-typed, and one unescaped quote produces a plist iOS rejects with no explanation.

  The asset URL is an **absolute** `…/download?token=…` built from `resolveServerAddress`, and it carries a **freshly minted token, never the caller's**: iOS fetches the IPA in a separate request that carries none of the browser's cookies and none of the original query string, so the URL inside the manifest has to stand on its own — including when an admin previews the manifest from a signed-in session.

  **iOS only follows this flow over HTTPS with a certificate the device already trusts.** Over plain HTTP the `itms-services://` link silently does nothing: no prompt, no error. That is why `capabilities.iosInstallable` is gated on `address.https`, and why `appDownloadBaseUrl` exists. See [Apple's constraints](#apples-constraints) for what else has to be true.
- **Errors:** `400` (`file` not whitelisted), `401` (plain), `404` `Not Found` (plain — unknown build id, or the file is missing from disk).
- **Example:**
  ```bash
  # with an install token, as a phone would
  curl -sS -o media-box.apk \
    "$MEDIABOX_URL/api/v1/apps/9f3c2a1b4d5e6f70/download?token=$MEDIABOX_INSTALL_TOKEN"

  # with an API key, e.g. to inspect the manifest a build would produce
  curl -sS "$MEDIABOX_URL/api/v1/apps/9f3c2a1b4d5e6f70/manifest.plist" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/apps/link`

Mint everything needed to get one build onto one device: a scannable link, the QR code for it, a direct tokenised download URL, and a short code for a device that has a remote instead of a camera. All of them expire together, 30 minutes out.

The QR points at the install **page** rather than at the binary, because iOS can only start an install from a link tapped in Safari, and because the page can tell an iPhone from an Android before deciding what to offer.

- **Auth:** User. Any signed-in user may mint a link for any build — that is what lets a household member get the app onto their own phone without an admin doing it for them, and the token it produces grants nothing but that one build's download for half an hour.
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `buildId` | string | yes | non-empty; an `id` from `GET /apps` |

- **Response:** `200` —
  ```json
  {
    "buildId": "9f3c2a1b4d5e6f70",
    "installUrl": "http://192.168.1.10:7878/get/9f3c2a1b4d5e6f70.1757845200000.Ab3…",
    "downloadUrl": "http://192.168.1.10:7878/api/v1/apps/9f3c2a1b4d5e6f70/download?token=9f3c…",
    "shortUrl": "http://192.168.1.10:7878/apk/H7K2QP",
    "code": "H7K2QP",
    "expiresAt": 1757845200000,
    "ttlMs": 1800000,
    "qrSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\" …></svg>",
    "address": { "baseUrl": "…", "source": "request", "https": false, "candidates": ["…"] }
  }
  ```
  `qrSvg` encodes `installUrl` and is complete SVG markup, rendered on the server (margin 1, error-correction level `M`) so the encoder stays out of the browser bundle — inline it as-is. `expiresAt` is epoch ms and belongs to the short **code**; the token carries its own, equal, expiry inside itself, and `ttlMs` is the 30-minute constant both were minted with. `address` is the same object `GET /apps` returns, so the caller can show which host these links were built from. Errors: `400` `Invalid request body`, `401`, `404` `Build not found`, `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/apps/link" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"buildId":"9f3c2a1b4d5e6f70"}'
  ```

---

## `POST /api/v1/apps/tv/install`

Push an Android build onto a TV across the LAN using `adb`, so nobody has to type a URL with a remote. Admin-only: this reaches out to another device on the network and installs software on it.

- **Auth:** Admin.
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `buildId` | string | yes | non-empty; must name an **android** build |
  | `host` | string | yes | the TV's IPv4 literal or hostname **on its own** — no port, no scheme, no path |
  | `port` | number (coerced int, 1–65535) | no | adb's port; defaults to `5555` |
  | `pairPort` | number (coerced int, 1–65535) | no | Android 11+ wireless debugging: the ephemeral pairing port shown on the TV |
  | `pairCode` | string, exactly six digits | no | the six-digit code shown beside it |

  Supplying **either** pairing field turns the pair step on, after which both are required and validated. Pairing is a one-off per device (it exchanges a certificate, and its port dies with the on-screen dialog); later installs go straight to connect, which is why both stay optional. Older Android TV boxes skip pairing entirely.

- **What it runs,** in order, each as an argv array and never through a shell: `adb pair <host>:<pairPort> <code>` (only when pairing), `adb connect <host>:<port>`, `adb -s <host>:<port> install -r <apk>`, then `adb disconnect <host>:<port>` in a `finally` — the disconnect happens even when the install blew up, because adb otherwise keeps the device in its list where the next attempt finds it stale and refuses. Timeouts: pair 30 s, connect 20 s, install 240 s, disconnect 10 s.

  Host and pairing code are validated **before the first spawn**. `isValidHost` accepts an IPv4 literal or a plain hostname/FQDN and nothing else — it rejects an embedded port (`1.2.3.4:5555`, which would silently override the port), a scheme, a path separator, a leading `-` (adb would read it as a flag) and anything with whitespace. IPv6 is deliberately not accepted.

  Failure is read from adb's **output**, not its exit status: `adb connect` has long exited `0` while printing `failed to connect to '10.0.0.2:5555'`, and `adb install` prints `Failure [INSTALL_FAILED_…]` on stdout regardless of status.

- **Response:** `200` — `{ "installed": true, "serial": "10.0.0.2:5555", "transcript": "$ adb connect 10.0.0.2:5555\nconnected to 10.0.0.2:5555\n\n$ adb -s 10.0.0.2:5555 install -r media-box-1.0.0-android.apk\nSuccess\n…" }`. `transcript` is every command run and its output, meant to be shown to the admin verbatim. Errors:
  - `400` `Invalid request body` (Zod), `Enter the TV's IP address or hostname on its own, with no port or scheme`, or `Only Android builds can be installed over the network`.
  - `401` / `403`.
  - `404` `Build not found`.
  - **`503`** — the server has no `adb` binary: `{ "error": "adb is not available on the server, so it cannot install to a TV directly. Use the short code and on-screen steps instead." }`. Check `capabilities.adb` from `GET /apps` before offering the action at all. The published Docker image installs `adb`; a bare host install may not have it.
  - **`502`** — adb ran and the install failed: `{ "error": "<step> failed: <the line adb printed>", "transcript": "<the whole session, including the failing command>" }`. adb's own words say far more than this route could invent — a wrong pairing code, `INSTALL_FAILED_INSUFFICIENT_STORAGE`, `device offline`, `unauthorized` (the "Allow USB debugging?" prompt was never accepted) and a timeout are only distinguishable there.
  - `500` for anything else.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/apps/tv/install" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"buildId":"9f3c2a1b4d5e6f70","host":"10.0.0.42","pairPort":41234,"pairCode":"483920"}'
  ```

---

## `POST /api/v1/apps/tv/instructions`

Steps for installing a build on one particular TV by hand, written by the configured AI provider when there is one and falling back to built-in generic steps when there isn't. The menu path to "unknown sources" differs enough between a Fire TV, a Google TV and a six-year-old Sony that generic steps alone leave people stuck. Minting a short code and a download token is a side effect, so the steps can name an address that really works.

- **Auth:** User.
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `buildId` | string | yes | non-empty; an `id` from `GET /apps` |
  | `brand` | string, ≤ 60 chars | no | free text, e.g. `Amazon` |
  | `model` | string, ≤ 60 chars | no | free text, e.g. `Fire TV Stick 4K` |
  | `os` | string, ≤ 60 chars | no | free text, e.g. `Fire OS 7` |

- **Response:** `200` —
  ```json
  {
    "steps": ["From the Fire TV home screen open search …", "Open Settings …"],
    "source": "ai",
    "shortUrl": "http://192.168.1.10:7878/apk/H7K2QP",
    "code": "H7K2QP",
    "expiresAt": 1757845200000
  }
  ```
  `source` is `"ai"` or `"builtin"`. `warning` is present **only** when the AI was tried and its answer was not used, and says why: the answer didn't look like install steps, it didn't use this server's download address, or the provider errored. With no provider configured the built-in steps come back as `"builtin"` with no warning. The call never throws — the page always has something to render. Errors: `400` `Invalid request body`, `401`, `404` `Build not found`, `500`.
- **Built-in steps** branch on the device family guessed from `brand`/`model`/`os`: Fire TV, Google TV, plain Android TV, or a non-Android set (Roku, LG webOS, Samsung Tizen, Apple tvOS), which gets steps explaining that the TV only installs from its own store and that a cheap Android stick is the way in. At most 12 steps, each at most 300 characters.
- **The model's output is untrusted text headed for a browser,** so it is sanitised rather than trusted: markup, code fences, headings and `javascript:`/`data:`/`file://` schemes are dropped; markdown links keep their label and lose their URL; then every address-shaped token is checked against the two URLs the server handed the model. An address on this server's host but a different path is repaired back to the short URL; an address on any other host (bar `google.com`, `amazon.com` and `aftvnews.com`, which a model legitimately names when pointing at the Downloader app) rejects the whole answer, as does an answer that never mentions this server's address at all. Either way the built-in steps come back with a `warning`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/apps/tv/instructions" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"buildId":"9f3c2a1b4d5e6f70","brand":"Amazon","model":"Fire TV Stick 4K","os":"Fire OS 7"}'
  ```

---

## Public install pages (not API routes)

These two paths live outside `/api/v1`, but they are what the QR code and the TV short code actually point at, so they belong here. `proxy.ts` lists `/get` and `/apk` in `PUBLIC_PAGES`, so both load with no session and no login redirect; each validates its own credential.

### `GET /get/{token}`

Where a scanned QR code lands (the `installUrl` from `POST /apps/link`). Deliberately account-free: the person holding the phone is trying to *get* the app, so requiring them to sign in first would be a circular door. The signed token in the URL is the credential and it names exactly one build for 30 minutes. The page verifies the token itself; an expired or forged one renders "This install link has expired" rather than an error status.

What it offers depends on the build and on the `User-Agent`:

- **Android** — a Download button pointing at the *relative* `/api/v1/apps/{id}/download?token=…`, plus the three steps Android actually needs (the first install asks permission to install from the browser, then the file has to be opened again).
- **iOS, over trusted HTTPS, with a `bundleId` on the build** — an `itms-services://?action=download-manifest&url=<absolute manifest URL>` link, plus a note that the first launch may need Settings → General → VPN & Device Management to trust the developer.
- **iOS otherwise** — an explanation instead of a button that cannot work: either that the server is being reached over plain HTTP and iOS will refuse, or that the build has no bundle identifier recorded.
- An iPhone that opens a link for the Android build is told so.

### `GET /apk/{code}`

The short URL a TV remote can type, e.g. `/apk/H7K2QP`. It is a **`302` redirect straight to the APK, not a page**: Downloader-style TV apps want a URL that *returns the file* and will not run a landing page. It resolves the code (case- and whitespace-insensitive), mints a **fresh** install token for the build that code names, and redirects to `/api/v1/apps/{id}/download?token=…`.

**The `Location` header is a relative path**, deliberately, so the TV's own HTTP client resolves it against whichever host the TV used to reach the server — which is by definition an address that works from the TV. Redirecting to an absolute origin computed server-side would reintroduce exactly the "the QR points at the wrong host" failure this feature exists to avoid.

An unknown or expired code returns `404` with the plain-text body `That install code has expired. Generate a new one in Media Box.` Codes are held in memory, so a server restart expires them all early.

---

## Apple's constraints

Nothing here can route around what Apple permits, and three rules bound what the iOS half of this feature can do:

- **A self-hosted iPhone install needs a paid Apple Developer Program membership.** The IPA has to be signed with a distribution certificate and a matching provisioning profile; an unsigned build will not install however it is served.
- **Ad-hoc distribution — which is what the `itms-services` manifest here serves — is capped at 100 devices per product family per membership year** (iPhone is its own family). Each device's UDID has to be registered in the developer account and baked into the provisioning profile *before* the build is made, so an ad-hoc IPA only installs on phones that were already known when it was built. Adding a phone later means registering it and rebuilding.
- **The manifest and the IPA must both be served over HTTPS with a certificate the device already trusts.** A self-signed certificate is not enough. This is the practical blocker on a LAN-only deployment, and the reason `appDownloadBaseUrl` accepts a public HTTPS origin.
- **TestFlight is the alternative that avoids all of that**, at the cost of not involving this server: up to 100 internal testers and up to 10,000 external testers, builds expire after 90 days, and an external build needs Apple's beta review. That is what the `appTestflightUrl` setting is for — set it and the UI shows the link to iPhone and Apple TV users.
- **tvOS has no sideloading path at all.** There is no `itms-services` equivalent for an Apple TV and no "unknown sources" switch; apps arrive from the App Store or through TestFlight and nowhere else. An Apple TV cannot install anything this server hands out — `POST /apps/tv/install` is adb, which is Android-only, and the built-in instructions for a non-Android set say so plainly and suggest an Android stick instead.

Android has none of these constraints: an APK installs from any source once the user grants "install unknown apps" to whatever fetched it, which is why the Android half of this feature works on a plain-HTTP LAN with no developer account.

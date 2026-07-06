# Auth, Users & Account

Authentication endpoints for first-run setup, login/logout, the kiosk-token exchange, self-service account settings, and admin user management. Every request authenticates via the `session` cookie or an `x-api-key: <apiKey>` header (treated as a synthetic admin, id `0`, username `api`). Success bodies come from `ok(...)` (200 unless noted); errors use `badRequest` (400), `notFound` (404), `serverError` (500, or 400 on a Zod `ValidationError` with an `issues` array, or 409 on `MediaWritesDisabledError`).

## `GET /api/v1/auth/setup`

Report whether first-run setup is still required (no users exist yet).

- **Auth:** public
- **Response:** `200` — `{ "setupRequired": true }` (`true` when the user table is empty, else `false`). Errors: `500` — unexpected failure.
- **Example:**
  ```bash
  curl -sS -X GET "$MEDIABOX_URL/api/v1/auth/setup"
  ```

## `POST /api/v1/auth/setup`

First-run only: create the initial `admin` account and sign it in. Rejected once any user exists.

- **Auth:** public
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `username` | string | yes | — | 2–50 chars; stored trimmed + lowercased |
  | `password` | string | yes | — | 8–200 chars |

- **Response:** `201` — the created user `{ "id": number, "username": string, "role": "admin" }`, and sets the `session` httpOnly cookie (30-day expiry). Errors: `400` — `"Setup already completed"` when a user already exists, or Zod `"Validation failed"` on a bad body.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/setup" \
    -H 'content-type: application/json' \
    -d '{ "username": "admin", "password": "supersecret" }'
  ```

## `POST /api/v1/auth/login`

Verify credentials and start a session.

- **Auth:** public
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `username` | string | yes | — | min 1 char; matched trimmed + lowercased |
  | `password` | string | yes | — | min 1 char |

- **Response:** `200` — `{ "id": number, "username": string, "role": "admin" | "user" }`, and sets the `session` httpOnly cookie (30-day expiry). Errors: `401` — `"Invalid username or password"`; `400` — Zod validation.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -d '{ "username": "admin", "password": "supersecret" }'
  ```

## `POST /api/v1/auth/logout`

End the current session and clear the cookie. No-op if no valid session is present.

- **Auth:** public
- **Response:** `200` — `{ "ok": true }`, and deletes the `session` cookie (also removes the matching session row if the cookie was set).
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/logout" \
    -H "Cookie: session=$MEDIABOX_SESSION"
  ```

## `POST /api/v1/auth/kiosk`

Kiosk/cast token exchange. A TV browser or a Fully Kiosk tablet opening a `/tv/<channel>?key=…` URL posts the shared kiosk token here; when it matches, a session is minted for the low-privilege `kiosk` user (a normal `user`-role account, created on first use) so the device can play channels/streams with no real login. Rotate the token via `POST /api/v1/kiosk` to revoke all issued links.

- **Auth:** public
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `key` | string | yes | — | min 1 char; the shared kiosk token (from `GET /api/v1/kiosk`) |

- **Response:** `200` — `{ "ok": true }`, and sets the `session` httpOnly cookie (30-day expiry) for the kiosk user. Errors: `401` — `"Invalid or expired kiosk link"` (no token configured or mismatch); `400` — Zod validation.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/kiosk" \
    -H 'content-type: application/json' \
    -d '{ "key": "<kiosk-token>" }'
  ```

## `GET /api/v1/auth/me`

Return the signed-in user derived from the request (cookie or api key).

- **Auth:** user
- **Response:** `200` — `{ "id": number, "username": string, "role": "admin" | "user", "roleId": number | null, "roleName": string | null, "permissions": string[] }` (api-key requests report `{ "id": 0, "username": "api", "role": "admin", "permissions": [<all>] }`). `roleId`/`roleName` are the assigned custom role (null for admins/unassigned users); `permissions` is the resolved capability list — admins hold every permission, a non-admin holds whatever their role grants. Errors: `401` — `"Not signed in"`.
- **Example:**
  ```bash
  curl -sS -X GET "$MEDIABOX_URL/api/v1/auth/me" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/auth/change-password`

Change the signed-in user's own password after verifying the current one.

- **Auth:** user
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `currentPassword` | string | yes | — | min 1 char; must match the stored hash |
  | `newPassword` | string | yes | — | min 8 chars (`"New password must be at least 8 characters"`) |

- **Response:** `200` — `{ "changed": true }`. Errors: `401` — `"Not signed in"`; `404` — `"User not found"`; `400` — `"Current password is incorrect"` or Zod validation.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/change-password" \
    -H "Cookie: session=$MEDIABOX_SESSION" -H 'content-type: application/json' \
    -d '{ "currentPassword": "old-pw", "newPassword": "new-strong-pw" }'
  ```

## `POST /api/v1/auth/kiosk`

Public kiosk/cast token exchange: a TV/tablet posts the shared kiosk token and receives a session bound to the low-privilege `kiosk` user (created on first use, `user` role).

- **Auth:** public
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `key` | string | yes | — | min 1 char; must equal `getSettings().kioskToken` |

- **Response:** `200` — `{ "ok": true }`, and sets the `session` httpOnly cookie for the kiosk user. Errors: `401` — `"Invalid or expired kiosk link"` (token unset or mismatched); `400` — Zod validation.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/auth/kiosk" \
    -H 'content-type: application/json' \
    -d '{ "key": "the-shared-kiosk-token" }'
  ```

## `GET /api/v1/account`

The signed-in user's own account settings.

- **Auth:** user
- **Response:** `200` — `{ "username": string, "role": "admin" | "user", "pushoverUserKey": string | null, "pushoverConfigured": boolean }` (`pushoverConfigured` reflects whether the admin has set the Pushover app token in settings). Errors: `401` — `"Not signed in"`.
- **Example:**
  ```bash
  curl -sS -X GET "$MEDIABOX_URL/api/v1/account" \
    -H "Cookie: session=$MEDIABOX_SESSION"
  ```

## `PUT /api/v1/account`

Update the signed-in user's own account settings (currently just the Pushover user key).

- **Auth:** user
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `pushoverUserKey` | string | no | — | max 64 chars; trimmed, and an empty string clears it to `null` |

- **Response:** `200` — `{ "saved": true }`. Errors: `401` — `"Not signed in"`; `400` — Zod validation.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/account" \
    -H "Cookie: session=$MEDIABOX_SESSION" -H 'content-type: application/json' \
    -d '{ "pushoverUserKey": "u123abc" }'
  ```

## `GET /api/v1/users`

List all users with their live activity (online/offline, now-streaming, last-watched, request counts), admins first then alphabetical.

- **Auth:** admin
- **Response:** `200` — an array of user-activity objects, each: `{ "id": number, "username": string, "role": "admin" | "user", "roleId": number | null, "roleName": string | null, "createdAt": number (ms epoch), "lastSeenAt": number | null, "online": boolean, "requestCount": number, "nowStreaming": null | { kind: "movie" | "episode", title, subtitle, poster, progressPct, positionSeconds, durationSeconds, updatedAt }, "lastWatched": null | { kind, title, subtitle, poster, watched: boolean, updatedAt } }`. `roleId`/`roleName` are the assigned custom role (see `/roles`). Errors: `401` — `"Authentication required"`; `403` — `"Admin access required"`.
- **Example:**
  ```bash
  curl -sS -X GET "$MEDIABOX_URL/api/v1/users" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/users`

Create a new user (admin action).

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `username` | string | yes | — | 2–50 chars; stored trimmed + lowercased |
  | `password` | string | yes | — | 8–200 chars |
  | `role` | `"admin"` \| `"user"` | no | `"user"` | account role |
  | `roleId` | number \| null | no | null | custom role to assign (see `/roles`); ignored/cleared for admins |

- **Response:** `201` — the created user `{ "id": number, "username": string, "role": "admin" | "user" }`. Errors: `401` — `"Authentication required"`; `403` — `"Admin access required"`; `400` — Zod validation or `"Unknown role"`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/users" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H 'content-type: application/json' \
    -d '{ "username": "alice", "password": "alice-password", "role": "user" }'
  ```

## `PUT /api/v1/users/[id]`

Update a user's account role and/or assigned custom role (admin action).

- **Auth:** admin
- **Path params:** `id` (number) — the user id to update
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `role` | `"admin"` \| `"user"` | no | unchanged | account role |
  | `roleId` | number \| null | no | unchanged | custom role to assign (null clears it); forced to null when the resulting role is `admin` |

- **Response:** `200` — `{ "updated": true }`. Errors: `401`/`403`; `404` — `"User not found"`; `400` — `"Invalid id"`, `"Unknown role"`, or `"You can't remove your own admin access"`.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/users/42" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H 'content-type: application/json' \
    -d '{ "roleId": 3 }'
  ```

## `DELETE /api/v1/users/[id]`

Delete a user by id. An admin cannot delete their own account.

- **Auth:** admin
- **Path params:** `id` (number) — the user id to delete
- **Response:** `200` — `{ "deleted": true }`. Errors: `401` — `"Authentication required"`; `403` — `"Admin access required"`; `400` — `"Invalid id"` (non-integer) or `"Cannot delete your own account"`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/users/42" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## Roles & permissions

Custom, admin-defined roles grant granular capabilities to non-admin users. The
built-in `admin` role is super-admin (holds every permission, bypasses all
checks) and is independent of these. Permission keys in v1: `requests.approve`
(approve/decline any request), `releases.search` (interactive search + grab /
override). Assign a role to a user via `POST`/`PUT /api/v1/users/[id]`.

### `GET /api/v1/roles`

- **Auth:** admin
- **Response:** `200` — array of `{ "id": number, "name": string, "permissions": string[], "userCount": number, "createdAt": number }`.

### `POST /api/v1/roles`

- **Auth:** admin
- **Request body:** `{ "name": string (1–60), "permissions": string[] }` — unknown permission keys are dropped.
- **Response:** `201` — the created role. Errors: `409` — `"A role with that name already exists"`; `400` — Zod validation.

### `PUT /api/v1/roles/[id]`

- **Auth:** admin
- **Request body:** `{ "name"?: string, "permissions"?: string[] }` (either or both).
- **Response:** `200` — `{ "updated": true }`. Errors: `404` — `"Role not found"`; `409` — duplicate name; `400` — `"Invalid id"`.

### `DELETE /api/v1/roles/[id]`

Delete a role, first clearing it from any users that hold it.

- **Auth:** admin
- **Response:** `200` — `{ "deleted": true }`. Errors: `404` — `"Role not found"`; `400` — `"Invalid id"`.

## `GET /api/v1/kiosk`

Return the current kiosk token, minting and persisting one on first access.

- **Auth:** admin
- **Response:** `200` — `{ "token": string }` (existing `kioskToken`, or a freshly minted 48-hex-char token). Errors: `401` — `"Authentication required"`; `403` — `"Admin access required"`.
- **Example:**
  ```bash
  curl -sS -X GET "$MEDIABOX_URL/api/v1/kiosk" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/kiosk`

Rotate the kiosk token — invalidates every previously issued cast link.

- **Auth:** admin
- **Response:** `200` — `{ "token": string }` (the new token). Errors: `401` — `"Authentication required"`; `403` — `"Admin access required"`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/kiosk" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

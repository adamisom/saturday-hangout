# Architecture

One Worker file, one KV namespace. No frameworks, no build step, no client-side JS. Everything fits on one screen if you squint.

## Request flow

```
Clients
┌─────────────────┐  ┌────────────────┐  ┌─────────────────┐
│ Browser         │  │ Claude / GPT   │  │ curl / phone    │
│ (HTML dash)     │  │ (web fetch)    │  │ browser         │
└────────┬────────┘  └────────┬───────┘  └────────┬────────┘
         │                    │                   │
         └──────── HTTPS GETs (token in URL) ─────┘
                              │
                              ▼
                 ┌──────────────────────────┐
                 │ Cloudflare Worker        │
                 │   app.js                 │
                 │                          │
                 │  ┌────────────────────┐  │
                 │  │ Router  fetch({})  │  │
                 │  └─────────┬──────────┘  │
                 │   ┌────────┴─────────┐   │
                 │   ▼                  ▼   │
                 │  HTML pages       API    │
                 │  landing/         handlers
                 │  dashboard/      set, view
                 │  join/signup     allow,…│
                 │        └────┬─────┘      │
                 │             ▼            │
                 │  ┌────────────────────┐  │
                 │  │ Storage adapter    │  │
                 │  │ getUser / putUser  │  │
                 │  │ authUser           │  │
                 │  └─────────┬──────────┘  │
                 └────────────┼─────────────┘
                              ▼
                 ┌──────────────────────────┐
                 │ Cloudflare KV  `STATE`   │
                 │  user:<name>   → {…}     │
                 │  invite:<code> → {…}     │
                 └──────────────────────────┘
```

Three client surfaces, one server, one store. The Worker derives its own base URL from the incoming request, so the same code runs at `*.workers.dev` or a custom domain with no config change.

## Modules

Everything is in [app.js](app.js). The file is small enough that "module" really means "section" — but the responsibilities are distinct.

| Module | What it does | Key functions |
|---|---|---|
| **Router** | Single dispatch in `fetch()`. Matches path → handler. | `export default { fetch }` |
| **Response helpers** | Wrap `Response` with the right content-type. Escape HTML. | `html()`, `text()`, `err()`, `escapeHtml()` |
| **Identity** | Token generation, username validation, Claude snippet builder. | `genToken()`, `genInvite()`, `validUsername()`, `claudeSnippet()` |
| **Time** | ISO + clock formatting (per-user tz); relative-time strings; expiry check. | `nowIso()`, `fmtRelative()`, `fmtClock()`, `activeLocation()` |
| **Storage adapter** | The only place that talks to KV. Wraps JSON serialization + token check. | `getUser()`, `putUser()`, `authUser()` |
| **HTML pages** | Server-rendered pages: landing, dashboard, invite display, join form, signup confirmation. | `landing()`, `dashboard()`, `makeInvite()`, `joinPage()`, `signup()` |
| **API handlers** | One per endpoint. All return plain text. | `setLocation()`, `clearLocation()`, `showMe()`, `viewUser()`, `allow()`, `disallow()`, `setPublic()`, `goSilent()`, `setTz()`, `deleteAccount()`, `claudeInstructions()` |
| **Admin** | First-user creation and token rotation, guarded by `BOOTSTRAP_SECRET`. | `bootstrap()`, `rotateToken()` |

The storage adapter is the load-bearing abstraction — every other module flows through it. If we ever swap KV for D1 / SQLite / Durable Objects, only this module changes.

## Data model

The entire app is two key types in one KV namespace.

**`user:<username>`** — one per registered user:

```json
{
  "token": "3459d514a9a8cd546bff0b6a84469c4f0e66",
  "allowlist": ["michael", "sarah"],
  "public": false,
  "location": {
    "text": "Pershing Cafe",
    "expiresAt": "2026-05-24T21:55:00.000Z"
  },
  "tz": "America/Chicago",
  "createdAt": "2026-05-17T18:02:11.831Z"
}
```

- `token` is the user's password (random 144 bits, hex-encoded). Compared directly — no hashing because tokens already live in URLs and the threat model is "friends, not adversaries."
- `allowlist` is one-directional: my list controls who can see *me*.
- `location` is null until set, then `{text, expiresAt}`. Expiry is checked at read time (no cron) — `activeLocation()` returns null for expired entries without rewriting them.
- `tz` is the user's IANA timezone (default `America/Chicago`). Used to format clock times in responses. When viewing someone else's `/u/<name>`, the time renders in the *viewer's* tz, not the target's.

**`invite:<code>`** — one per generated invite:

```json
{
  "from": "adam",
  "used": false,
  "createdAt": "2026-05-24T19:00:00.000Z",
  "expiresAt": "2026-05-31T19:00:00.000Z",
  "usedBy": "michael",
  "usedAt": "2026-05-24T19:05:12.000Z"
}
```

Single-use, 7-day TTL. Both `used` and `expiresAt` are checked in `joinPage` and `signup`. After signup, `used:true` is set and `usedBy/usedAt` are filled. We don't delete consumed invites — keeping them lets us trace the signup graph if needed.

That's the whole schema. No accounts table, no sessions table, no cookies.

## Request lifecycle: walking through `/set`

A concrete example — Claude (or curl, or a browser) hits `/set?u=adam&t=XYZ&loc=Pershing+Cafe&hours=3`:

1. **Worker entry.** Cloudflare invokes `fetch(request, env)`. We parse the URL and extract `path = "/set"`, `q = URLSearchParams{...}`.
2. **Router.** `path === '/set'` → call `setLocation(env, q)`.
3. **Auth.** `setLocation` calls `authUser(env, "adam", "XYZ")` → reads `user:adam` from KV, JSON-parses, checks `user.token === "XYZ"`. Returns the user object or `null`.
4. **Input validation.** Trim `loc`, enforce ≤200 chars. Parse `hours` as float, default 2, clamp to (0, 24].
5. **Mutation.** Compute `expiresAt = ISO(now + hours * 3600s)`. Set `user.location = {text, expiresAt}`. Write back with `putUser` (JSON-serializes and puts to KV).
6. **Response.** Return plain text: `OK. Location set: Pershing Cafe (3h, until 4:55 PM CT).`

Every API endpoint follows this shape: auth → validate → mutate (or read) → plain-text response. Predictable enough that adding a new endpoint is a 10-minute change.

## Design choices and tradeoffs

- **GET for writes.** Unconventional — REST convention is POST/PUT. We use GET because it's the one HTTP verb every chat-assistant web-fetch tool reliably supports. No cache layer sits in front of the Worker, so the usual GET-side-effect risks (prefetch, replay) don't apply.
- **Token in URL.** Equivalent to a password in the URL. Logs (Cloudflare + assistant conversation history) will see it. Acceptable for a friends app; document the tradeoff in client setup.
- **Direct token compare, no hashing.** If the token leaks via a log, hashing wouldn't save us — the leak path is the URL itself. So we skip the bcrypt ceremony.
- **KV (not D1 / Durable Objects).** KV is eventually consistent — writes typically propagate globally in <1 second. That's fine for location updates. D1 (SQLite) or Durable Objects would buy strong consistency we don't need, in exchange for more setup.
- **Expiry at read time, no cron.** `activeLocation()` returns null for expired entries. Saves a scheduled trigger; expired entries just sit in KV until overwritten on next `set`.
- **List-scan for friends.** Dashboard renders by listing all `user:*` keys and filtering visible ones. O(N) per dashboard view, fine up to a few hundred users. If we ever grow past that, add a `subscribers:<username>` reverse index.
- **No frontend framework.** Pages are server-rendered HTML strings. The dashboard form posts via plain `<form action="/set" method="get">` — no JavaScript executes in the browser. Friends with JS disabled (rare but possible) still get a working app.
- **Single file.** At ~700 lines, the app is still small enough that splitting into modules costs more than it saves (chasing imports, deciding what's a module). Revisit if it crosses ~1000.

## Operations

- **Logs:** `npx wrangler tail` streams live request logs.
- **KV inspection:** `npx wrangler kv key list --binding STATE` lists keys; `npx wrangler kv key get --binding STATE user:adam` reads a value.
- **Token rotation:** if a friend loses their bookmark or a token leaks, hit `/rotate?s=<BOOTSTRAP_SECRET>&u=<name>` — it mints a fresh token and prints the new dashboard URL. See [readme → Token rotation](readme.md#token-rotation).
- **Backup:** KV doesn't auto-backup. For this app it's not worth a job — the entire DB can be dumped via `kv key list` + a loop, and the loss of "friends' current location after a CF disaster" is fine. If you'd rather have a daily snapshot, that's ~15 lines added to a scheduled Worker trigger.

## Future work: end-to-end encryption

**Trigger:** a friend expresses concern that the worker owner can read their data, or you want to truthfully tell a new invitee "no, I can't see your locations."

### What admin can read today

[for-friends.md](for-friends.md) discloses that the worker owner can read everything — via raw KV (`wrangler kv key get`), `/rotate` (mints any user's token), and tokens in `wrangler tail`. You own the Cloudflare account, so the data and the keys both live where you have access. This is fine for the current "friends, not adversaries" model, but a non-starter once a friend wants a cryptographic answer instead of a social one.

### Primitive: keys in the URL fragment

Browsers never send `#…` to the server. So the dashboard URL becomes `…/dashboard?u=alice&t=TOKEN#sk=PRIVATEKEY`. Logs, KV, and `wrangler tail` see only the query string. About 150 lines of client-side WebCrypto in the dashboard do the encrypt/decrypt. This departs from the current "no JS in the browser" rule — server-rendered HTML still works for everything except the location string itself.

*Multi-device:* the key lives in the URL, not on the device. Friends sync phone + laptop the same way they sync today's token URL — password manager, email-to-self. No per-device enrollment. If we later want device-bound keys (passkeys, secure-enclave), `user.pubs` becomes an array of `{device_label, pub}` capped at 3 and senders encrypt to all of them — separate upgrade, only worth it if URL-fragment-as-key starts feeling like a liability.

### Design: per-user X25519 keypairs

This is **real end-to-end encryption**: place names are encrypted in the friend's browser to the recipient's public key, and only the recipient's private key can decrypt. Cloudflare and you-as-admin, in your normal capacity, cannot read them — the plaintext never reaches the server, and the private keys never reach the server.

- Each user gets an X25519 keypair at signup. `user.pub` stored in KV; private key only in the URL fragment.
- `user.location` becomes `{ recipients: { name: {ct, iv}, ... }, expiresAt }` — sender encrypts the place name once per allowlisted friend (NaCl-style addressed delivery).
- Recipient's `/u/<sender>` returns just their addressed ciphertext + the sender's pub; recipient decrypts with their private key.
- Server learns only ciphertexts, IVs, expiry, and the social graph (recipient-map keys are usernames). Place names are opaque.

A friend not in your allowlist has no ciphertext addressed to them in KV — including you-as-admin if a friend doesn't allowlist you. "Admin can see all" stops being structurally true.

### What this costs (besides the dev work)

- **Claude integration goes away.** Claude can't run WebCrypto and can't see fragments. Drop both reads and writes from the snippet; the bookmark path (already documented as the default in `for-friends.md`) becomes the only flow. Net effect: simpler product surface, cleaner privacy story.
- **Public mode goes away.** Conflicts with addressed-delivery. Replace with allowlist + "Go silent" — already the more-used path.
- **Modern browsers only.** WebCrypto X25519 needs Chrome 113+, Safari 17+, Firefox 130+. Fine for a 2026 friends app.

### The one residual risk: the JS itself

E2EE protects the data, but the *client code* that does the encryption is downloaded fresh from the worker on every visit. A future admin who deploys malicious JS could exfiltrate keys or plaintext at that point. This is separate from the crypto being correct — and it's the standard wrinkle for any browser-based E2EE (it's why Signal Desktop ships as a binary, not a webpage).

Mitigations, in order of effort:

- **Periodic audit.** A friend reads the deployed worker source before sensitive sessions. Cheap, real, requires discipline.
- **SRI pinning.** Host the JS bundle at a third-party URL (GitHub Pages, jsDelivr) with a hash committed in the worker. Admin can still serve a different HTML, but a watchful friend would notice the change.
- **Browser extension.** Distribute the client as a small extension friends install once. Now the admin no longer controls what code runs in the browser — same model as Signal Desktop. Real lift, real guarantee.

For the friend who asks "can you see my data?", the honest answer is: "No — and you can verify by reading the deployed source. The only way I could change that is by shipping malicious code, which is visible in the worker source you can audit, and which SRI or extension distribution can lock down further if you care."

### Endpoints affected

| Endpoint | Change |
|---|---|
| `/signup` | Accept browser-generated `pub`; redirect to dashboard URL with `#sk=…` |
| `/set` | `r=<base64-json-recipients-map>` instead of `loc=<text>` |
| `/pubkeys?u=&t=` *(new)* | Returns pubs of `u`'s allowlist + their own |
| `/u/<name>` | Returns `{ct, iv, sender_pub, expiresAt}`; 403 if `as=` not in recipients |
| `/dashboard`, `/me` | Embed JS bundle, return ciphertexts, render after decrypt |
| `/rotate` | Also regenerates `pub`; old ciphertexts addressed to friend become unreadable (TTL handles cleanup) |
| `/claude`, `/public`, `/silent` (public-mode bit) | Delete; remove `claudeSnippet()` |

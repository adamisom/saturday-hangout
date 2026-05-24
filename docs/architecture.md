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
                 │   src/worker.js          │
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

Everything is in [src/worker.js](../src/worker.js). The file is small enough that "module" really means "section" — but the responsibilities are distinct.

| Module | What it does | Key functions |
|---|---|---|
| **Router** | Single dispatch in `fetch()`. Matches path → handler. | `export default { fetch }` |
| **Response helpers** | Wrap `Response` with the right content-type. Escape HTML. | `html()`, `text()`, `err()`, `escapeHtml()` |
| **Identity** | Token generation, username validation, Claude snippet builder. | `genToken()`, `genInvite()`, `validUsername()`, `claudeSnippet()` |
| **Time** | ISO + CT clock formatting; relative-time strings; expiry check. | `nowIso()`, `fmtRelative()`, `fmtClockCT()`, `activeLocation()` |
| **Storage adapter** | The only place that talks to KV. Wraps JSON serialization + token check. | `getUser()`, `putUser()`, `authUser()` |
| **HTML pages** | Server-rendered pages: landing, dashboard, invite display, join form, signup confirmation. | `landing()`, `dashboard()`, `makeInvite()`, `joinPage()`, `signup()` |
| **API handlers** | One per endpoint. All return plain text. | `setLocation()`, `clearLocation()`, `showMe()`, `viewUser()`, `allow()`, `disallow()`, `setPublic()`, `claudeInstructions()` |
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
  "createdAt": "2026-05-17T18:02:11.831Z"
}
```

- `token` is the user's password (random 144 bits, hex-encoded). Compared directly — no hashing because tokens already live in URLs and the threat model is "friends, not adversaries."
- `allowlist` is one-directional: my list controls who can see *me*.
- `location` is null until set, then `{text, expiresAt}`. Expiry is checked at read time (no cron) — `activeLocation()` returns null for expired entries without rewriting them.

**`invite:<code>`** — one per generated invite:

```json
{
  "from": "adam",
  "used": false,
  "createdAt": "2026-05-24T19:00:00.000Z",
  "usedBy": "michael",
  "usedAt": "2026-05-24T19:05:12.000Z"
}
```

Single-use. After signup, `used:true` is set and `usedBy/usedAt` are filled. We don't delete consumed invites — keeping them lets us trace the signup graph if needed.

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
- **Single file.** When the whole app fits in one screen-height of imports + 400 lines of logic, splitting into modules costs more than it saves.

## Operations

- **Logs:** `npx wrangler tail` streams live request logs.
- **KV inspection:** `npx wrangler kv key list --binding STATE` lists keys; `npx wrangler kv key get --binding STATE user:adam` reads a value.
- **Token rotation:** if a friend loses their bookmark or a token leaks, hit `/rotate?s=<BOOTSTRAP_SECRET>&u=<name>` — it mints a fresh token and prints the new dashboard URL. See [README → Token rotation](../README.md#token-rotation).
- **Backup:** KV doesn't auto-backup. For this app it's not worth a job — the entire DB can be dumped via `kv key list` + a loop, and the loss of "friends' current location after a CF disaster" is fine. If you'd rather have a daily snapshot, that's ~15 lines added to a scheduled Worker trigger.

# Manual test plan

Walk through this top-to-bottom after your first deploy. It covers every endpoint, the admin flow, the invitee flow, cross-user visibility, expiry, recovery, and persistence — plus an edge-case pass. Each step has an **expected result** so you can spot regressions.

Estimated time end-to-end: **~30 minutes** (plus a 75-second wait in Phase 4).

## How to simulate "Sanya" without a real friend

Use two browser contexts so each "user" has their own URL bar:

- **Browser A** = Adam (your admin account). Use your normal browser.
- **Browser B** = Sanya (the invitee). Use **a different browser** (e.g. Chrome if Adam is Safari) OR an Incognito / Private window. Keep both open side-by-side.

You'll paste different dashboard URLs into each. No login state to manage — the token in the URL is the whole auth.

## Setup checklist

- [ ] `wrangler.toml` has the real KV namespace `id` filled in (not the placeholder)
- [ ] `BOOTSTRAP_SECRET` is set via `npx wrangler secret put BOOTSTRAP_SECRET`
- [ ] `npx wrangler deploy` succeeded; you have the base URL
- [ ] In a scratchpad, write down: `BASE=https://saturday-hangout.<your-acct>.workers.dev`, `SECRET=<your-bootstrap-secret>`
- [ ] In a second scratchpad area, prepare slots: `ADAM_TOKEN=___`, `SANYA_TOKEN=___`, `INVITE=___`, `SANYA_NEW_TOKEN=___`

---

## Phase 0 — Pre-flight (smoke)

- [ ] **0.1** Visit `BASE/` in Browser A.
  Expect: HTML landing page with "Hangout" h1 and a login form.
- [ ] **0.2** Visit `BASE/nothing-here` in Browser A.
  Expect: `Not found` (plain text, HTTP 404 — check DevTools Network tab if curious).

---

## Phase 1 — Admin / first-user flow (Adam in Browser A)

### Bootstrap

- [ ] **1.1** Visit `BASE/bootstrap?s=WRONG&u=adam`.
  Expect: `Error: Forbidden.` (HTTP 403).
- [ ] **1.2** Visit `BASE/bootstrap?s=<SECRET>&u=AD@M` (invalid chars).
  Expect: `Error: Invalid username...`
- [ ] **1.3** Visit `BASE/bootstrap?s=<SECRET>&u=admin` (reserved word).
  Expect: `Error: Invalid username...`
- [ ] **1.4** Visit `BASE/bootstrap?s=<SECRET>&u=adam`.
  Expect: `User created. Username: adam. Token: <hex>`. **Record token as `ADAM_TOKEN`.**
- [ ] **1.5** Visit the same URL again.
  Expect: `Error: Username already taken.`

### Dashboard

- [ ] **1.6** Visit `BASE/dashboard?u=adam&t=WRONG`.
  Expect: "Invalid login" page (HTTP 401).
- [ ] **1.7** Visit `BASE/dashboard?u=adam&t=<ADAM_TOKEN>`.
  Expect: dashboard with "Hi, adam", "No active location", placeholder "Pershing Cafe", empty allowlist, empty friends. **Bookmark this URL right now.**

### Set / read own location

- [ ] **1.8** From the dashboard form, set place = `Pershing Cafe`, hours = `2`. Submit.
  Expect: plain-text `OK. Location set: Pershing Cafe (2h, until <clock> CT).`
- [ ] **1.9** Click your browser's Back arrow → land on dashboard.
  Expect: top section now reads **Pershing Cafe** with "1h 59m left (until <clock>)".
- [ ] **1.10** Visit `BASE/me?u=adam&t=<ADAM_TOKEN>`.
  Expect: lines for username/public/allowlist/location, location string matches.

### Public mode

- [ ] **1.11** Open `BASE/u/adam` in an Incognito window (no auth).
  Expect: `adam's location is not shared with you.` (HTTP 403).
- [ ] **1.12** Back in dashboard, click "Turn on" under Public mode.
  Expect: plain text `OK. Public mode: ON.`
- [ ] **1.13** Reload the Incognito `BASE/u/adam`.
  Expect: `adam is at Pershing Cafe (...).` (HTTP 200).
- [ ] **1.14** Reload dashboard → click "Turn off."
  Expect: `OK. Public mode: OFF.`
- [ ] **1.15** Reload Incognito `BASE/u/adam`.
  Expect: back to "not shared".

### Clear

- [ ] **1.16** Reload dashboard → click "Clear."
  Expect: `OK. Location cleared.` Back-button shows "No active location."
- [ ] **1.17** `BASE/me?u=adam&t=<ADAM_TOKEN>` → `Location: (none)`.

---

## Phase 2 — Invitee flow (Sanya in Browser B)

### Generate invite as Adam

- [ ] **2.1** In Browser A, dashboard → "Generate invite link."
  Expect: a `BASE/join?invite=<code>` URL.  **Copy this URL as `INVITE_URL`.**
- [ ] **2.2** Generate a second invite (just for testing dup behavior).
  Expect: a different code each time.

### Sanya signs up

- [ ] **2.3** In **Browser B**, open `INVITE_URL`.
  Expect: "Join Hangout" page saying "Invited by **adam**".
- [ ] **2.4** Type `adam` as username → submit.
  Expect: `Error: Username already taken.`
- [ ] **2.5** Type `admin` → submit.
  Expect: `Error: Invalid username...`
- [ ] **2.6** Type `Sanya` (capital S) → submit.
  Expect: the HTML pattern `[a-z0-9-]{3,20}` blocks submission in modern browsers; if your browser allows it, the server lowercases on `signup()` and it works as `sanya`. (Test confirms case-handling.)
- [ ] **2.7** Type `sanya` → submit.
  Expect: "Welcome, sanya!" page. **Record token as `SANYA_TOKEN`.**

### Sanya opens her dashboard

- [ ] **2.8** Click "Open dashboard" link.
  Expect: dashboard with "Hi, sanya", **adam** in allowlist, **adam** in friends list (showing "no location" because Adam cleared in 1.16).
- [ ] **2.9** **Bookmark this URL in Browser B.**

### Cross-check: Adam's allowlist

- [ ] **2.10** In Browser A, reload dashboard.
  Expect: allowlist now shows **sanya**, friends list shows **sanya** (no location).

### Invite already used

- [ ] **2.11** In Browser B, open `INVITE_URL` again (the same one Sanya used).
  Expect: "This invite has already been used." (HTTP 410).
- [ ] **2.12** Visit `BASE/join?invite=garbage`.
  Expect: "Invalid invite code." (HTTP 404).

---

## Phase 3 — Cross-user visibility

### Sanya sets location

- [ ] **3.1** Browser B: dashboard form → `Mozart's Coffee`, `1` hour → submit.
  Expect: `OK. Location set: Mozart's Coffee (1h, until <clock> CT).`
- [ ] **3.2** Browser A: reload dashboard.
  Expect: sanya's row in friends now shows **Mozart's Coffee** with relative time.
- [ ] **3.3** `BASE/u/sanya?as=adam&t=<ADAM_TOKEN>` in Browser A.
  Expect: `sanya is at Mozart's Coffee (...)`

### Adam sets location, Sanya sees

- [ ] **3.4** Browser A: set `Pershing Cafe`, `2` hours.
- [ ] **3.5** Browser B: reload dashboard.
  Expect: adam row shows **Pershing Cafe**.

### Disallow

- [ ] **3.6** Browser A: dashboard → next to "sanya" in allowlist, click `[remove]`.
  Expect: `OK. sanya can no longer see your location.`
- [ ] **3.7** Browser B: reload dashboard.
  Expect: **adam disappears from friends list entirely** (since sanya is no longer in adam's allowlist AND adam isn't public, sanya can no longer see adam's record).
- [ ] **3.8** `BASE/u/adam?as=sanya&t=<SANYA_TOKEN>`.
  Expect: `adam's location is not shared with you.`

### Re-allow + public mode test

- [ ] **3.9** Browser A: dashboard → Add `sanya` to allowlist.
- [ ] **3.10** Browser B: reload → adam reappears.
- [ ] **3.11** Browser A: Public mode → "Turn on."
- [ ] **3.12** Browser B: open `BASE/u/adam` (no `?as=` query — anon access).
  Expect: `adam is at Pershing Cafe (...)` (HTTP 200) — public mode lets anyone see.
- [ ] **3.13** Browser A: Public mode → "Turn off."

### Self-view: `/u/adam` with `?as=adam`

- [ ] **3.14** `BASE/u/adam?as=adam&t=<ADAM_TOKEN>`.
  Expect: `adam's location is not shared with you.` — interesting: viewing yourself isn't auto-allowed unless you're in your own allowlist. Not a bug; matches the rule "allowlist controls who can see me," and `me` isn't in `my-allowlist` by default. If this bothers you, that's a documented quirk to fix later.

---

## Phase 4 — Expiry

- [ ] **4.1** Browser A: set location with `loc=Test Place`, `hours=0.02` (≈72 seconds).
  Expect: `OK. Location set: Test Place (0.02h, until <clock> CT).`
- [ ] **4.2** Within 10 seconds, `BASE/me?u=adam&t=<ADAM_TOKEN>` → shows the location with "1 min left."
- [ ] **4.3** **Wait 75 seconds.** (Time it.)
- [ ] **4.4** `BASE/me?u=adam&t=<ADAM_TOKEN>` → `Location: (none)`.
- [ ] **4.5** `BASE/u/adam?as=sanya&t=<SANYA_TOKEN>` → `adam has no active location.`
- [ ] **4.6** Reload dashboard in Browser A → "No active location."

---

## Phase 5 — Token rotation (recovery flow)

This is the "Sanya lost her bookmark" simulation.

- [ ] **5.1** Browser B: set sanya's location to `Recovery Test`, `2` hours. Confirm.
- [ ] **5.2** Note `SANYA_TOKEN` (the original).
- [ ] **5.3** From Browser A or a terminal:
      `curl "$BASE/rotate?s=<SECRET>&u=sanya"`
  Expect: `Token rotated for sanya. New token: <hex>. Send them this URL: /dashboard?u=sanya&t=<hex>`. **Record as `SANYA_NEW_TOKEN`.**
- [ ] **5.4** Browser B: reload (with old token in URL).
  Expect: "Invalid login" page (HTTP 401).
- [ ] **5.5** Browser B: open `BASE/dashboard?u=sanya&t=<SANYA_NEW_TOKEN>`.
  Expect: full dashboard, with **location still `Recovery Test`** and **allowlist still containing `adam`**. (Rotation only changes the token; everything else persists.)
- [ ] **5.6** Bookmark the new URL; delete the old bookmark.

### Negative path

- [ ] **5.7** `curl "$BASE/rotate?u=sanya"` (no secret) → `Error: Forbidden.` (403)
- [ ] **5.8** `curl "$BASE/rotate?s=wrong&u=sanya"` → 403.
- [ ] **5.9** `curl "$BASE/rotate?s=<SECRET>"` (no user) → `Error: Missing u`.
- [ ] **5.10** `curl "$BASE/rotate?s=<SECRET>&u=ghost"` → `Error: No such user: ghost.` (404)

---

## Phase 6 — Persistence across re-deploy

- [ ] **6.1** Note current state of both users:
      `curl "$BASE/me?u=adam&t=<ADAM_TOKEN>"`
      `curl "$BASE/me?u=sanya&t=<SANYA_NEW_TOKEN>"`
- [ ] **6.2** In your local repo: `cd ~/dev/saturday-hangout && npx wrangler deploy` (no code changes).
- [ ] **6.3** Re-run both `/me` curls.
  Expect: byte-identical output (modulo "X min left" time-formatting changes).
- [ ] **6.4** Open both dashboards in browsers.
  Expect: all friends, allowlists, locations, public-mode flags unchanged.

This proves KV state survives Worker re-deploys (it does — KV is the storage layer, deploys only replace code).

---

## Phase 7 — Edge cases & error paths

### Auth

- [ ] **7.1** `BASE/set?u=adam&t=&loc=X` (empty token) → 401.
- [ ] **7.2** `BASE/set?loc=X&hours=1` (no u/t) → 401.
- [ ] **7.3** `BASE/me?u=adam` (no token) → 401.
- [ ] **7.4** `BASE/me?u=ghost&t=anything` → 401.

### Validation

- [ ] **7.5** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=&hours=1` (empty location) → `Error: Missing loc.`
- [ ] **7.6** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=` + 201-char string → `Error: Location too long`. (Try `loc=$(printf 'x%.0s' {1..201})` if using curl.)
- [ ] **7.7** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=Cafe&hours=abc` → defaults to 2.
- [ ] **7.8** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=Cafe&hours=0` → defaults to 2.
- [ ] **7.9** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=Cafe&hours=99` → clamped to 24.
- [ ] **7.10** `BASE/u/Sanya?as=adam&t=<ADAM_TOKEN>` (mixed case) → works (server lowercases target).
- [ ] **7.11** `BASE/u/?as=adam&t=<ADAM_TOKEN>` (empty target) → 404 Not found.
- [ ] **7.12** `BASE/allow?u=adam&t=<ADAM_TOKEN>` (no friend param) → `Error: Missing friend.`
- [ ] **7.13** `BASE/disallow?u=adam&t=<ADAM_TOKEN>&friend=ghost` (non-allowlisted target) → succeeds idempotently with `OK. ghost can no longer see your location.`

### XSS / HTML escaping

- [ ] **7.14** Browser A: set location to `<script>alert('xss')</script>` (3 hours).
  Expect: `OK. Location set: <script>alert('xss')</script> (3h, ...)` — plain text response is fine.
- [ ] **7.15** Reload dashboard.
  Expect: dashboard shows the literal text `<script>alert('xss')</script>` (NO alert popup). DevTools → Elements: the text is escaped as `&lt;script&gt;...`.
- [ ] **7.16** Browser B (Sanya): reload dashboard → adam's row shows the same literal text, no popup.
- [ ] **7.17** Clear it: dashboard → Clear.

### Special characters

- [ ] **7.18** Set location to `Pershing Cafe & Books` (with `&`).
  Expect: properly URL-decoded by the worker (`&loc=Pershing+Cafe+%26+Books` in URL); displays correctly.
- [ ] **7.19** Set location with an emoji `Pershing 🌮`.
  Expect: works; URL-encoded and decoded round-trip preserves it.

---

## Phase 8 — Claude integration (optional)

If you want to validate the AI assistant path now (covered in detail by [clients.md](clients.md)):

- [ ] **8.1** Create `~/.claude/commands/hangout.md` from the template in clients.md, with your username + `ADAM_TOKEN` filled in.
- [ ] **8.2** In any `claude` session: `/hangout I'm at Pershing Cafe for 2 hours.`
  Expect: Claude fires WebFetch and quotes `OK. Location set: ...`
- [ ] **8.3** `/hangout sanya` → Claude returns sanya's location.
- [ ] **8.4** `/hangout clear` → Claude clears.

---

## Data-persistence checkpoints (running through every phase)

These are inline already, but to summarize the pattern: **after every write, do a read.**

| Write | Verify by |
|---|---|
| `/set` | `/me` + reload dashboard |
| `/clear` | `/me` shows `Location: (none)` |
| `/allow` | `/me` allowlist contains the friend |
| `/disallow` | `/me` allowlist excludes the friend |
| `/public?on=1` | `/me` shows `Public mode: ON` |
| `/signup` | sender's `/me` allowlist contains the new user; new user's allowlist contains sender |
| `/rotate` | new dashboard URL works; old returns 401; all other fields preserved |

---

## Code gaps I noticed (not in the test plan because they're not bugs — but you may want to fix before broader sharing)

### 1. Invite codes never expire

**Risk:** an invite link you sent in May could be used by anyone who finds it in October. If a friend forwards an invite by accident or it ends up in a screenshot, the recipient can sign up indefinitely.
**Fix:** add `expiresAt` to the invite record (default 7 days). Check in `joinPage` and `signup`. ~8 lines.

### 2. No way to delete your own account

Once signed up, sanya can never leave the app. She can clear her location and turn off public, but her username stays reserved forever.
**Fix:** `DELETE /me?u=&t=` endpoint that removes the `user:<name>` key. Optionally cascades through every other user's allowlist to remove references. ~25 lines.

### 3. `/u/<unknown>` returns 404, `/u/<unauthorized>` returns 403 — both messages reveal whether a username exists

Minor privacy leak — an attacker who knows your worker URL can probe usernames.
**Fix:** return identical "not shared / no such user" message in both cases, with status 403. ~3 lines.

### 4. No "go silent" macro

To fully hide, sanya has to (a) clear her location AND (b) turn public off. Two clicks. Could be one button.
**Fix:** `/silent?u=&t=` endpoint that clears location + sets public=false in one call. ~8 lines.

### 5. Self-viewing quirk (Phase 3.14)

`/u/adam?as=adam` returns "not shared with you" because Adam isn't in his own allowlist. Surprising but not harmful. Adam can always read himself via `/me`.
**Fix (if desired):** in `viewUser`, special-case `target === viewer` → return as if allowed. ~3 lines.

### 6. Time zone hard-coded to America/Chicago

Sanya in PST will see "until 4:55 PM CT" with no conversion. Not a bug for you (Austin, CT). Future fix: pass viewer's TZ as a query param or use a JS sniff on the client side.
**Fix:** ~10 lines to make TZ configurable per user record.

### 7. Dashboard doesn't auto-refresh

If sanya updates her location while adam is staring at his dashboard, he won't see it until he reloads. Acceptable for a "drop by" app — the cadence is human-scale.
**Fix (if it matters):** add `<meta http-equiv="refresh" content="60">` to the dashboard HTML. 1 line.

---

## Self-review pass (holes I found in my own plan while reviewing)

While writing this I caught these additional cases worth confirming — already inlined above:

- **2.5/2.6:** reserved usernames + case sensitivity. Both should land cleanly.
- **2.11:** re-using a consumed invite should explicitly return HTTP 410, not just generic error.
- **3.14:** self-view returns "not shared" — surprising, documented as gap #5.
- **5.7–5.10:** all four `/rotate` failure modes (no secret, wrong secret, no user, ghost user). Easy to miss; covered.
- **6.x:** persistence across re-deploy was the original ask but easy to forget mid-flow. Pulled into its own phase.
- **7.10:** `/u/Sanya` (mixed case) — the server lowercases targets, so this works. Worth confirming.
- **7.14–7.16:** XSS via location text — server-side escaping is what protects us. Easy regression target if dashboard HTML ever moves to a templating library; explicit test catches it.

If you discover any flow during testing that this plan doesn't cover, add a row — I'll fold it into the plan or into the code gaps list.

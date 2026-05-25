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

**Note on response shapes for write actions** (`/set`, `/clear`, `/silent`, `/allow`, `/disallow`, `/public`, `/tz`): when called from the dashboard's forms/links, these 303-redirect back to the dashboard (so you stay in context). When called directly via curl/Claude (no `&return=dashboard` in the URL), they return plain text as before. Tests that click dashboard buttons expect re-render; tests that curl expect plain text.

- [ ] **1.6** Visit `BASE/dashboard?u=adam&t=WRONG`.
  Expect: "Invalid login" page (HTTP 401).
- [ ] **1.7** Visit `BASE/dashboard?u=adam&t=<ADAM_TOKEN>`.
  Expect: dashboard with "Hi, adam" and the following sections **in this order**:
  - **Where I am** — "No active location" + form with placeholder "Pershing Cafe"
  - **Friends** — empty
  - **Allowlist (who can see me)** — empty
  - **Invite a friend** — "Generate invite link" button
  - **Public mode** — currently OFF
  - **Go silent**
  - **Connect Claude / ChatGPT (optional, one-time)**
  - **Settings** — `Timezone: America/Chicago`
  - **Delete account** — clickable "Delete account…" button (don't click it)
  
  The page auto-refreshes every 60s. **Bookmark this URL right now.**

### Set / read own location

- [ ] **1.8** From the dashboard form, set place = `Pershing Cafe`, hours = `2`. Submit.
  Expect: **dashboard re-renders in place** (303 redirect back to `/dashboard?u=&t=`). The "Where I am" section now reads **Pershing Cafe** with "1h 59m left (until <clock>)". No plain-text OK page — the form includes a hidden `&return=dashboard` that triggers the redirect.
- [ ] **1.9** Verify via curl: `BASE/me?u=adam&t=<ADAM_TOKEN>`.
  Expect: `Location: Pershing Cafe (1h 59m left, until <clock> CDT)` — confirms the KV state matches what the dashboard showed.
- [ ] **1.10** Visit `BASE/me?u=adam&t=<ADAM_TOKEN>`.
  Expect: five lines — Username, Public mode, Timezone (default `America/Chicago`), Allowlist, Location. Location string matches what you set in 1.8.

### Public mode

- [ ] **1.11** Open `BASE/u/adam` in an Incognito window (no auth).
  Expect: `adam's location is not shared with you.` (HTTP 403).
- [ ] **1.12** Back in dashboard, click "Turn on" under Public mode.
  Expect: dashboard re-renders (303 redirect); Public mode now shows "ON" and the button reads "Turn off". No plain-text OK page.
- [ ] **1.13** Reload the Incognito `BASE/u/adam`.
  Expect: `adam is at Pershing Cafe (...).` (HTTP 200).
- [ ] **1.14** Click "Turn off."
  Expect: dashboard re-renders with Public mode "OFF" and button back to "Turn on".
- [ ] **1.15** Reload Incognito `BASE/u/adam`.
  Expect: back to "not shared".

### Clear

- [ ] **1.16** Click "Clear" from the dashboard (the secondary button next to Update location).
  Expect: dashboard re-renders with "No active location." in the Where-I-am section.
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
  Expect: **the join form re-renders in place** (URL stays at `/signup`, no back-button needed) with a red error: `Username already taken. Try "adam2" instead.` The username input is pre-filled with `adam2` so you can just hit Submit again to accept the suggestion. (Server suggests the first available `${name}<n>` for n in 2..5; falls back to plain "Username already taken." if no candidate is free in that range.)
- [ ] **2.5** Type `admin` → submit.
  Expect: the join form re-renders in place with a red error: `Invalid username — must be 3–20 lowercase letters/digits/dashes, and not a reserved word.` Username input is pre-filled with `admin` for editing.
- [ ] **2.6** Type `Sanya` (capital S) → submit.
  Expect: the HTML pattern `[a-z0-9-]{3,20}` blocks submission in modern browsers; if your browser allows it, the server lowercases on `signup()` and it works as `sanya`. (Test confirms case-handling.)
- [ ] **2.7** Type `sanya` → submit.
  Expect: **Welcome page** with:
  - H1: "Welcome, sanya!"
  - One line: "You and **adam** can now see each other."
  - "Your dashboard URL:" with the full URL in a `<pre>` block (this URL contains the token; it's what to save)
  - **"Go to Dashboard"** button
  - Small-text footer: link to `for-friends.md` on GitHub and link to "get your Claude/ChatGPT setup snippet" — both `target="_blank"` (open in new tab)
  
  **Record the token** (it's the `t=` value inside the URL) as `SANYA_TOKEN`.

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
  Expect: dashboard re-renders with sanya removed from the Allowlist. (No plain-text OK page — `[remove]` link includes `&return=dashboard`.)
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
  Expect: `adam is at <place> (...)` or `adam has no active location.` — viewing yourself is allowed (the self-view fix). For your own canonical state use `/me`.

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
  Expect: full dashboard, with **location still `Recovery Test`**, **allowlist still containing `adam`**, and **timezone, public mode, and all other fields preserved**. Only the token changes.
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
- [ ] **7.12b** `BASE/allow?u=adam&t=<ADAM_TOKEN>&friend=does-not-exist` (unknown user) → `Error: No such user: does-not-exist.` (HTTP 404). Allowlist isn't modified. *Disclosing existence is fine — endpoint is auth-gated; only invited users have a token to call it.*
- [ ] **7.12c** `BASE/allow?u=adam&t=<ADAM_TOKEN>&friend=adam` (self) → `Error: You can't add yourself to your own allowlist.` (HTTP 400). Self-view doesn't need this — `viewUser` already lets you see your own location.
- [ ] **7.13** `BASE/disallow?u=adam&t=<ADAM_TOKEN>&friend=ghost` (non-allowlisted target) → succeeds idempotently with `OK. ghost can no longer see your location.` *(Disallow stays lenient — removing a name that isn't there is a no-op, not an error.)*

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

### Newline / control-whitespace strip

- [ ] **7.20** `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=Hello%0AWorld&hours=1` (newline embedded in loc).
  Expect: server replaces `\r\n\t` with single spaces → `OK. Location set: Hello World (1h, ...)`. Then `/me` shows `Location: Hello World ...` on a single line — `/me`'s 5-line contract holds, so any line-based reader (Claude via WebFetch, etc.) parses correctly.

---

## Phase 9 — New endpoints (silent / tz / delete / invite expiry)

These cover the gap-fix endpoints added in commit 3.

### /silent (Gap 4)

- [ ] **9.1** Set adam's location: `BASE/set?u=adam&t=<ADAM_TOKEN>&loc=Anywhere&hours=2`.
- [ ] **9.2** Turn public mode on.
- [ ] **9.3** `BASE/silent?u=adam&t=<ADAM_TOKEN>`.
      Expect: `OK. Going silent: location cleared, public mode OFF.`
- [ ] **9.4** `/me` → confirm `Location: (none)` and `Public mode: OFF`.

### /tz (Gap 6)

- [ ] **9.5** `BASE/tz?u=adam&t=<ADAM_TOKEN>` (missing tz param).
      Expect: `Error: Missing tz. Use an IANA name like America/Los_Angeles.`
- [ ] **9.6** `BASE/tz?u=adam&t=<ADAM_TOKEN>&tz=Mars/Olympus`.
      Expect: `Error: Invalid timezone: Mars/Olympus.`
- [ ] **9.7** `BASE/tz?u=adam&t=<ADAM_TOKEN>&tz=America/Los_Angeles`.
      Expect: `OK. Timezone set to America/Los_Angeles.`
- [ ] **9.8** Set a location now. The confirmation should say `until <time> PDT` (not CT).
- [ ] **9.9** `/me` → `Timezone: America/Los_Angeles` and `until ... PDT`.
- [ ] **9.10** Browser B (Sanya, still on default CT): `BASE/u/adam?as=sanya&t=<SANYA_NEW_TOKEN>`.
      Expect: time renders in **CT** (sanya's tz), not PDT — confirms viewer-aware formatting.
- [ ] **9.11** Set adam back to `America/Chicago` for the rest of the plan.

### Invite expiry (Gap 1)

- [ ] **9.12** Generate a fresh invite.
      Expect: the invite confirmation page shows "Expires <date> (7 days from now)."
- [ ] **9.13** Visit the new invite URL in Browser B (without claiming it).
      Expect: normal "Join Hangout" page — invite is fresh.

(Full expiry verification requires a 7-day wait. Logic is straightforward — if you want to force it, edit the KV entry: `npx wrangler kv key get --binding STATE 'invite:<code>'`, change `expiresAt` to a past ISO timestamp, `kv key put` it back, then re-open the URL. Expected: "This invite has expired.")

### /delete with cascade (Gap 2)

⚠️ This phase **deletes a user**. Use a throwaway account, not sanya — or recreate sanya afterward via a fresh invite.

- [ ] **9.14** Adam: generate a new invite. Open it in a third browser context (or wipe Browser B's tab) and claim it as `throwaway`. Save the token.
- [ ] **9.15** `/me` for adam → allowlist now contains `throwaway`.
- [ ] **9.16** `BASE/delete?u=throwaway&t=<THROWAWAY_TOKEN>` (no confirm).
      Expect: `This will permanently delete the account "throwaway". To confirm, re-run with &confirm=yes appended.` (HTTP 400)
- [ ] **9.17** `BASE/delete?u=throwaway&t=<THROWAWAY_TOKEN>&confirm=yes`.
      Expect: `Account "throwaway" deleted. Your token is no longer valid.`
      
      *Equivalent UI path:* the dashboard's **"Delete account…"** button (bottom section) opens a JS `confirm()` dialog with the warning text; clicking OK navigates to this same URL with `&confirm=yes` appended. Server response is identical.
- [ ] **9.18** `BASE/me?u=throwaway&t=<THROWAWAY_TOKEN>` → 401 Invalid token.
- [ ] **9.19** `/me` for adam → **allowlist no longer contains `throwaway`** (cascade verified).

### Dashboard auto-refresh (Gap 7)

- [ ] **9.20** Open Browser A's dashboard.
- [ ] **9.21** View source / DevTools: confirm `<meta http-equiv="refresh" content="60">` is present in `<head>`.
- [ ] **9.22** Leave the tab idle ~65 seconds. Watch the page silently reload.

**Known tradeoff:** the meta-refresh interrupts in-progress form input. If you're mid-typing when the refresh fires, you lose your text. Acceptable for this app's "look at the dashboard, occasionally tap a button" usage; if it bites you, consider bumping the interval from 60s to 120s in `app.js` (search for `200, 60` in `dashboard()`).

### Username probe protection (Gap 3)

The unified-error fix means an attacker can't tell which usernames exist by hitting `/u/<name>` — nonexistent and unauthorized look identical.

- [ ] **9.23** `BASE/u/nonexistent-12345?as=adam&t=<ADAM_TOKEN>`.
      Expect: HTTP 403, body `nonexistent-12345's location is not shared with you.`
- [ ] **9.24** Make sanya invisible to adam, then probe. The access model checks the **target's** allowlist for the **viewer** (see `viewUser` in app.js), so to hide sanya from adam, **sanya** must disallow adam — not the other way around:
      `curl "$BASE/disallow?u=sanya&t=<SANYA_TOKEN>&friend=adam"`
      Then `BASE/u/sanya?as=adam&t=<ADAM_TOKEN>`.
      Expect: HTTP 403, body `sanya's location is not shared with you.` — **exact same shape as 9.23 modulo the username**, so a probe can't distinguish "no such user" from "user exists but not visible." Restore with `curl "$BASE/allow?u=sanya&t=<SANYA_TOKEN>&friend=adam"` after.

### /claude page (HTML + Copy button)

- [ ] **9.25** Visit `BASE/claude?u=adam&t=<ADAM_TOKEN>`.
  Expect: **HTML page** (not plain text). H1: "Connect Hangout to Claude or ChatGPT". Lede paragraph mentions "Paste this snippet **once**... Works on any plan, including free tier." A **Copy snippet** button is visible above a `<pre id="snippet">` block containing the snippet.
- [ ] **9.26** Click **Copy snippet**.
  Expect: button text changes to "Copied!" for ~2 seconds, then reverts to "Copy snippet". Paste into any text field — should be the full snippet (~30 lines starting with "You are connected to adam's Hangout app.") including the line linking to `for-friends.md` on GitHub.
- [ ] **9.27** Footer link reads **"Go to Dashboard"** (not "Back to dashboard"). Clicking returns to `/dashboard`.

### Invite-display footer wording

- [ ] **9.28** From the dashboard, click "Generate invite link." On the resulting page, the footer link reads **"Go to Dashboard"** (not "Back to dashboard").

### Invite chain cap (3 hops)

The cap (`MAX_INVITE_DEPTH = 3` in `app.js`) prevents transitive trust from growing without bound: owner (depth 0) → invitee → invitee → invitee (depth 3, cannot invite further).

- [ ] **9.29** Adam (depth 0) generates an invite. Inspect the invite record:
      `npx wrangler kv key get --binding STATE "invite:<code>"`
      Expect: JSON includes `"inviterDepth":0`.
- [ ] **9.30** Sign up a throwaway user via that invite, then inspect the new user record:
      `npx wrangler kv key get --binding STATE "user:throwaway"`
      Expect: JSON includes `"depth":1`.
- [ ] **9.31** (Optional, requires KV edit.) Set throwaway's depth to 3:
      Read → modify `depth` → write back with `npx wrangler kv key put --binding STATE "user:throwaway" '<json>'`. Then `BASE/invite?u=throwaway&t=<TOK>`.
      Expect: HTTP 403, `Error: Invite chain limit reached: your invitees would be 4 hops from the worker owner (max 3). Ask someone closer in the chain to invite your friend instead.`
      
      *Full-chain alternative:* build adam → A → B → C through 3 sequential signups, then have C try to invite. Same expected error. Heavy for a manual pass — code-reviewed instead.

---

## Phase 8 — Claude integration (optional)

If you want to validate the AI assistant path now (covered in detail by [for-friends.md](for-friends.md)):

- [ ] **8.1** Create `~/.claude/commands/hangout.md` from the template in for-friends.md, with your username + `ADAM_TOKEN` filled in.
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
| `/silent` | `/me` shows location none + public OFF |
| `/tz` | `/me` shows the new `Timezone:` value |
| `/signup` | sender's `/me` allowlist contains the new user; new user's allowlist contains sender |
| `/rotate` | new dashboard URL works; old returns 401; all other fields preserved |
| `/delete?confirm=yes` | every `/me` and `/dashboard` for that user returns 401; account is gone from every other user's allowlist |

---

## Resolved gaps (all 7 fixed in commit 3)

| # | Gap | Fix | New tests |
|---|---|---|---|
| 1 | Invites never expire | 7-day TTL; `expiresAt` on invite records; checked in `joinPage` + `signup`. | 9.12–9.13 |
| 2 | No account delete | `/delete?u=&t=&confirm=yes` with allowlist cascade. | 9.14–9.19 |
| 3 | `/u/<unknown>` vs `/u/<unauthorized>` leaked existence | Both now return identical 403 "not shared." | 9.23–9.24 |
| 4 | No "go silent" macro | `/silent` endpoint + dashboard button + Claude snippet entry. | 9.1–9.4 |
| 5 | Self-view returned "not shared" | `viewUser` special-cases `target === viewer`. | 3.14 (updated) |
| 6 | TZ hard-coded to CT | Per-user `tz` field (default `America/Chicago`); `/tz` endpoint; viewer-aware formatting in `/u/<name>`. | 9.5–9.11 |
| 7 | Dashboard didn't auto-refresh | `<meta http-equiv="refresh" content="60">` in dashboard `<head>`. | 9.20–9.22 |

### Follow-ups noticed during the fix pass

- **Auto-refresh interrupts form input.** Acceptable tradeoff (no client-side JS), but if it bites, dial the interval from 60s to 120s in `dashboard()`.
- **Deleting a user doesn't remove invites they generated.** Pending invites from a deleted user still work — a new signup would get a dangling reference to the deleted inviter. Edge case; can be patched in `deleteAccount` (scan `invite:*` and remove ones where `from` matches) if it ever matters.
- **Signup doesn't check whether the inviter still exists.** If `inv.from` was deleted between invite creation and use, the new user signs up with a dangling allowlist entry. The `if (inviter)` guard in `signup()` already handles the "inviter not found" case gracefully, but the dangling entry stays. Cleanup: filter the new user's allowlist for entries that resolve to real users at signup time.

---

## Self-review pass (holes I found in my own plan while reviewing)

While writing this I caught these additional cases worth confirming — already inlined above:

- **2.5/2.6:** reserved usernames + case sensitivity. Both should land cleanly.
- **2.11:** re-using a consumed invite should explicitly return HTTP 410, not just generic error.
- **3.14:** self-view now works (gap #5 fixed).
- **5.7–5.10:** all four `/rotate` failure modes (no secret, wrong secret, no user, ghost user). Easy to miss; covered.
- **6.x:** persistence across re-deploy was the original ask but easy to forget mid-flow. Pulled into its own phase.
- **7.10:** `/u/Sanya` (mixed case) — the server lowercases targets, so this works. Worth confirming.
- **7.14–7.16:** XSS via location text — server-side escaping is what protects us. Easy regression target if dashboard HTML ever moves to a templating library; explicit test catches it.

If you discover any flow during testing that this plan doesn't cover, add a row — I'll fold it into the plan or into the code gaps list.

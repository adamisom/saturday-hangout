# Connecting clients to Hangout

This is **the friend-facing onboarding doc.** If Sanya signed up via your invite and asks "now what?", point her here.

There are two ways for her to use Hangout: a **browser bookmark** (works for everyone, no Claude account needed) and an **AI assistant integration** (Claude or ChatGPT, sandboxed so it can't misfire). Pick one. Or both — they don't interfere.

---

## Path A — Browser bookmark (recommended default)

Works on any phone / laptop / tablet with a browser. No Claude or ChatGPT account required. **This is what we suggest to friends first.**

### Setup (one minute)

1. Open the dashboard URL the signup page gave you: `https://saturday-hangout.<account>.workers.dev/dashboard?u=<your-username>&t=<your-token>`
2. **iOS Safari:** tap the share icon → **Add to Home Screen** → name it "Hangout" → Add.
   **Android Chrome:** ⋮ menu → **Install app** (or **Add to Home screen**).
   **Desktop:** bookmark it (⌘D / Ctrl+D).
3. Also save the URL to your password manager, notes app, or text it to yourself. **The URL contains your token — losing it means asking the worker owner for a rotation.** See [token recovery](#token-recovery) below.

That's it. Tap the home-screen icon → you're at the dashboard. Type a place, hit "Update location", done.

### What you can do from the dashboard

- Set / clear your location (default 2-hour expiry, max 24)
- See friends who've allowlisted you (or who are in public mode)
- Add / remove people from your own allowlist
- Toggle public mode on/off
- Generate an invite link to onboard your own friends

### Token recovery

If you lose your bookmark *and* every other copy of the URL, you're locked out — the URL's token is your password. **The fix:** text the person who invited you. They'll run a `/rotate` against the worker and send you a fresh URL. Old token immediately stops working.

---

## Path B — AI assistant integration

For when you want to update your location *during* a Claude or ChatGPT conversation, instead of switching to the browser. **Strictly optional.** The bookmark in Path A covers the same actions.

### The sandboxing rule (read this first)

The snippet you'll paste contains instructions like *"when I tell you where I am, fetch /set..."*. If pasted into a **global** instruction (default Claude.ai instructions, `~/.claude/CLAUDE.md`, ChatGPT memory), it WILL misfire on phrases like "I'm at home" or "I'll be in the kitchen" — Claude doesn't know "Hangout" is the topic, it just sees a trigger.

**Always use a sandboxed surface.** Every assistant offers one:

| Surface | Tier required | Sandbox | Misfire risk? |
|---|---|---|---|
| Claude Code (CLI) | free | Slash command (`/hangout ...`) | None |
| Claude Desktop | Pro ($20/mo) | Project (instructions scoped to that project) | None |
| Claude.ai web | Pro ($20/mo) | Project | None |
| Claude.ai mobile | Pro ($20/mo) | Project | None |
| ChatGPT Plus ($20/mo) | Plus | Custom GPT (instructions scoped to that GPT) | None |
| Claude.ai Free / ChatGPT Free | n/a | **No sandbox available** | **High — don't paste globally. Use Path A instead.** |

**The snippet itself** (what you paste): get it from `https://<your-worker>/claude?u=<you>&t=<your-token>`. It's pre-populated with your identity and a "paste response verbatim" rule (so the assistant doesn't summarize away the precise expiry times).

### Manual validation checklist (run on every surface)

After pasting the snippet:

1. **Read test:** *"Where is michael?"* → expect a `/u/michael?as=<you>&t=<your-token>` fetch and a reply like `michael is at Pershing Cafe (1h 23m left, until 3:18 PM CT).` or `michael's location is not shared with you.` or `michael has no active location.`
2. **Write test:** *"I'm at Pershing Cafe for 3 hours."* → expect `OK. Location set: Pershing Cafe (3h, until 4:55 PM CT).`
3. **Self-check:** *"What's my hangout state?"* → expect a `/me` fetch returning username, public mode, allowlist, current location.
4. **Cleanup:** *"Clear my location."* → expect `OK. Location cleared.`

If anything fails:
- Assistant refused to fetch URLs → you're on a tier without sandbox/web-fetch; use Path A instead.
- Assistant fetched but summarized → reinforce in chat: *"Paste the response body verbatim — don't summarize."*
- `Error: Invalid token.` → token had a stray space or quote when pasted.

---

## Surface-by-surface setup

### Claude Code (CLI)

**Tier:** any, including free. **Most reliable surface — `WebFetch` is deterministic.**

Best shape is a **slash command** — explicit invocation, zero misfire risk.

Create `~/.claude/commands/hangout.md`:

```markdown
---
description: Update or check Hangout locations.
---

Use the Hangout API. My identity:
- Username: <your-username>
- Token: <your-token>
- Base URL: https://saturday-hangout.<account>.workers.dev

If $ARGUMENTS sounds like a place ("I'm at X for N hours"), fetch /set?u=<me>&t=<tok>&loc=<place>&hours=<n>.
If $ARGUMENTS is a friend's username, fetch /u/<name>?as=<me>&t=<tok>.
If $ARGUMENTS is "clear", fetch /clear?u=<me>&t=<tok>.
If $ARGUMENTS is "silent" or "going silent" or "hide me", fetch /silent?u=<me>&t=<tok>.
If $ARGUMENTS is "me" or "state", fetch /me?u=<me>&t=<tok>.

Paste the response body back to me verbatim before any commentary.
```

Then in any Claude Code session:

- `/hangout I'm at Pershing Cafe for 3 hours`
- `/hangout michael`
- `/hangout clear`

**Validation:** run the 4-step checklist using `/hangout <args>`.

**Don't put the snippet in your global `~/.claude/CLAUDE.md`** — that'd make it apply to every conversation in every project, with full misfire risk. The slash command is the whole point.

---

### Claude Desktop / Claude.ai web

**Tier:** Claude Pro ($20/mo) — Projects require Pro.

1. Open Claude → **Projects** sidebar → **New project** → name it "Hangout".
2. Open the project → **Settings** (gear) → **Custom instructions**.
3. Paste the snippet from `/claude?u=<you>&t=<your-token>`. Save.
4. Start chats **inside that project** (project name should appear in the chat header).

**Validation:** 4-step checklist in a project chat.

**Gotcha:** Claude's "New chat" button sometimes opens *outside* the project. Always check the chat header shows "Hangout" before relying on the integration.

---

### Claude.ai mobile (iOS / Android)

**Tier:** Claude Pro.

Projects sync from your account, so the "Hangout" project you created on web/desktop is already there:

1. Open the Claude app → **Projects** tab → tap "Hangout" → **New chat**.

**Setup-from-mobile-only** (if no desktop handy): Projects → **+** → name "Hangout" → ⋯ menu → **Custom instructions** → paste the snippet.

**Validation:** 4-step checklist on phone.

**Gotcha:** if the assistant claims it "can't access external URLs," prompt explicitly: *"Use your web search tool to fetch this URL: [paste full URL]."* That usually unsticks it.

---

### ChatGPT Plus

**Tier:** ChatGPT Plus ($20/mo).

**Option A — Custom GPT (cleanest, fully sandboxed):**

1. chatgpt.com → **Explore GPTs** → **Create**.
2. Name: "Hangout". Description: anything.
3. **Instructions** field: paste the snippet.
4. **Capabilities**: enable web browsing.
5. Save → visibility **Only me** (the snippet contains your token).
6. Pin it to your sidebar.

**Option B — Memory (faster setup, less isolation):**

Paste into a normal ChatGPT chat:

> Remember this for future chats: I have a Hangout app. My username is `<you>`, token is `<your-token>`, base URL `https://saturday-hangout.<account>.workers.dev`. When I tell you where I am, fetch `<base>/set?u=<you>&t=<tok>&loc=<urlencoded place>&hours=<n>`. When I ask where a friend is, fetch `<base>/u/<name>?as=<you>&t=<tok>`. Paste the response body verbatim before commentary.

Memory applies to every ChatGPT conversation — *some* misfire risk, but lower than Claude.ai's because ChatGPT memory is more inert. Option A is still preferable.

**Validation:** 4-step checklist in the GPT or in any chat (if using Memory).

---

### ChatGPT Free / Claude.ai Free

**No sandboxed surface exists.** Don't paste the snippet into global memory or default instructions — too much misfire risk.

**Use Path A (browser bookmark) instead.** It's actually simpler.

---

## What to send Sanya

When you invite a friend, the signup confirmation page already shows them everything they need: their token, a dashboard link, and a link to their personal `/claude` snippet. Suggest in the invite message:

1. **Bookmark the dashboard URL on your phone** (and save it somewhere else — password manager, notes — as a backup).
2. **Optional:** if you use Claude Code, Claude Pro, or ChatGPT Plus, set up the integration (link to this doc).
3. If you lose your bookmark + every backup, text me — I'll mint you a fresh token.

That's the whole onboarding.

---

## Security notes

- **The token in the URL is your password.** It will appear in:
  - The assistant's conversation history (yours, and any screenshots you share)
  - Cloudflare worker access logs (visible to the worker owner — that's you, for everyone)
  - Browser address bar / history if you open dashboard URLs manually
- **Don't paste your `/claude` snippet anywhere public** — no screenshots of Project custom-instructions, no shared Custom GPTs.
- **Token rotation** is the recovery path. The worker owner runs `/rotate?s=BOOTSTRAP_SECRET&u=<name>` to mint a fresh token. The old token immediately stops working. See [README → Token rotation](../README.md#token-rotation).
- **Account deletion** is permanent and cascades — `/delete?u=&t=&confirm=yes` removes you from every other user's allowlist before deleting your record. Your token becomes invalid immediately.
- **Timezone** is stored per-user (default `America/Chicago`). Update via the dashboard's Settings section or `GET /tz?u=&t=&tz=America/Los_Angeles`. Friends viewing your location see times in their own tz, not yours.
- **Why no hashing of stored tokens?** Tokens already live in URLs in every request, so hashing the stored value wouldn't change the leak path. We skip the bcrypt ceremony deliberately. See [architecture.md → Design choices](architecture.md#design-choices-and-tradeoffs).

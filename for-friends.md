# Welcome to Hangout

Someone just invited you to **Hangout** — a tiny private app for letting friends know *"I'm at Pershing Cafe for 2 hours, drop by."* This doc walks you through claiming your account and using it.

Most people will use Hangout from a **browser bookmark on their phone** — the easy default, no Claude or ChatGPT account needed. If you already pay for Claude or ChatGPT, you can *optionally* drive it from a chat instead. That's strictly extra; the bookmark works perfectly on its own.

---

## What it does

- You set a place ("Pershing Cafe", optional hours, default 2). It auto-expires.
- Friends you've allowlisted see it. Or anyone, if you flip on Public mode for a while.
- They can do the same. Everyone's dashboard shows "here's where your friends are right now."
- That's the entire app. No DMs, no map, no social graph, no notifications.

Built so a small group of friends can coordinate ad-hoc hangs ("drop by if you're around") without group-chat noise.

---

## Step 1 — claim your account (1 minute)

**1. Tap the invite link you were sent.** It looks like `https://saturday-hangout.<something>.workers.dev/join?invite=<code>`.

**2. You'll see a page that says "Invited by &lt;friend&gt;."** Pick a username — lowercase letters/digits/dashes, 3 to 20 characters. (Things like `admin`, `set`, etc. are reserved; the form will tell you if you pick one of those.)

**3. Submit.** You'll land on a "Welcome" page that shows:
   - Your **username**
   - A **token** (a long string of hex — this is effectively your password, automatically generated for you, you don't pick it)
   - An **"Open dashboard"** button — the URL it opens already has your username and token baked in
   - A **"Connect Claude"** link — for the optional AI setup later (you can skip for now)

**4. ⚠️ This is the only time the Welcome page will appear.** Before doing anything else:

   - Click "Open dashboard" to land on your dashboard.
   - **Save the dashboard URL in at least two places.** The URL itself is your login — losing it means you're locked out. Suggested places:
     - A password manager (1Password / iCloud Keychain / Bitwarden — save it as a "login" entry)
     - Email it to yourself
     - Save it in your phone's Notes app
   - **On your phone, also Add to Home Screen:**
     - iOS Safari: tap the share icon → **Add to Home Screen** → call it "Hangout" → Add.
     - Android Chrome: tap the ⋮ menu → **Install app** (or "Add to home screen").

   This puts a Hangout icon on your home screen that opens your dashboard with one tap.

If you ever lose every copy of the URL, text the friend who invited you — they have an admin endpoint to mint you a fresh one.

---

## Step 2 — using it day-to-day (the browser path)

Tap your home-screen Hangout icon (or your bookmark) → dashboard opens.

You can:
- **Set your location** — type a place + hours, hit Update.
- **See where friends are** — listed under "Friends" (anyone who's allowlisted you, or anyone in public mode).
- **Allowlist someone** — type their username, click Add. Now they can see your location.
- **Remove someone** — `[remove]` link next to their name.
- **Toggle Public mode** — if on, anyone (with or without an account) can see you when they visit `/u/<your-username>`. Default off.
- **Go silent** — one button that clears your location AND turns Public off in a single tap. Use this when you're heading home.
- **Generate an invite link** — send it to your own friends so they can join.

The dashboard auto-refreshes every minute. Keep it open in a tab on your laptop and you'll see friends' updates without reloading.

**Most friends will stop here.** The rest of this doc is the optional AI integration. Feel free to bookmark this doc and skip ahead only if you decide you want it.

---

## Step 3 (optional) — drive it from Claude or ChatGPT

If you'd rather say *"I'm at Pershing for 2 hours"* in a chat you already have open than tap the bookmark, you can set that up. About 5 minutes of one-time setup, then you just chat normally.

### Read this first: where you put the setup matters

The setup tells the AI to fetch URLs when you say things like *"I'm at &lt;place&gt; for N hours."* If you put it into your **default** Claude or ChatGPT (the one you use for everything), the AI will misfire on phrases like *"I'm at home"* or *"I'll be in the kitchen"* — it doesn't know "Hangout" is the topic, it just sees a matching pattern.

So you'll put the setup in a **separate, scoped place** that only activates when you choose. Every major AI tool has one:

| You use... | Plan needed | The scoped place |
|---|---|---|
| **Claude.ai** (web, desktop, or mobile) | Pro ($20/mo) | A **Project** |
| **ChatGPT** | Plus ($20/mo) | A **Custom GPT** |
| Claude or ChatGPT on free tier | — | None available — **stick with the bookmark** |
| Claude Code (CLI, for developers) | any | A **slash command** (see Advanced section at the bottom) |

Pick whichever matches what you already use. If you're on a free tier and don't want to upgrade, no worries — the bookmark works for everyone.

### Step 3a — get your Claude snippet

The "Claude snippet" is a block of text containing your username, your token, and instructions for the AI. Roughly 30 lines.

**Easiest way to get it:** open your dashboard → scroll to the **"Connect Claude"** section → click **"Open Claude setup snippet."** That opens a plain-text page with the snippet, with your username and token already filled in.

(You can also reach the same page via the "Connect Claude" link on your original Welcome page, if it's still open.)

**On desktop:** select all (⌘A on Mac, Ctrl+A on Windows) → copy (⌘C / Ctrl+C).
**On phone:** tap and hold → "Select All" → Copy.

You'll paste this in the next step.

### Step 3b — paste it into your scoped place

#### → If you use Claude.ai (Pro plan)

This works the same in the web app (claude.ai), the desktop app, and the mobile app — they share your account.

1. Open Claude (claude.ai or the app).
2. In the left sidebar, find **Projects**. Click it.
3. Click **New project**. Name it **Hangout**.
4. Open the project. Find **Custom instructions** (sometimes inside a Settings / gear icon — UI wording varies a bit by version).
5. **Paste the snippet** into that field. Save.
6. From now on, **start chats from inside this Hangout project** — the chat header should show "Hangout." If you start a chat outside the project, the instructions won't apply (which is the whole point).

That's it. Try it: type *"What's my hangout state?"* — Claude should respond with your username, public mode, timezone, allowlist, and current location.

#### → If you use ChatGPT (Plus plan)

1. Open **chatgpt.com**.
2. In the left sidebar, click **Explore GPTs**.
3. Click **Create** (top right).
4. **Name it** "Hangout." Description: anything.
5. In the **Instructions** field, paste the snippet.
6. Scroll to **Capabilities** and enable **Web Browsing** (also called "Web Search" in some versions).
7. Set visibility to **Only me** — the snippet contains your token, never share it.
8. Click **Update** / **Save**. Pin the GPT to your sidebar for quick access.

That's it. Open the Hangout GPT and try: *"What's my hangout state?"*

#### → If you're on a free tier

There's no sandboxed place to put the snippet that wouldn't misfire on unrelated phrases. Just use the bookmark from Step 2 — it's actually faster than chatting once you have it on your home screen.

### Step 3c — test it works

After paste-and-save, run these inside your Project / Custom GPT:

1. *"What's my hangout state?"* → expect a reply listing your username, public mode, timezone, allowlist, and current location (or `(none)`).
2. *"I'm at Pershing Cafe for 3 hours."* → expect a confirmation like `OK. Location set: Pershing Cafe (3h, until 4:55 PM CT).`
3. *"Clear my location."* → expect `OK. Location cleared.`

If something looks off:
- The AI says *"I can't access external URLs"* → that's usually a tier limit. Skip the AI path; use the bookmark.
- The AI rephrases the response in its own words instead of quoting it → reply with *"Paste the response body exactly, don't summarize."*
- You get `Error: Invalid token` → the snippet picked up a stray space or quote when you pasted. Re-copy from the dashboard's snippet page and try again.

### Step 3d — using it (after setup)

Going forward, just open your Hangout project (Claude) or Hangout GPT (ChatGPT) and chat normally:

> *"I'll be at Pershing for the next 2 hours."*
> *"Where is sanya?"*
> *"Going silent, I'm heading home."*

You don't re-paste anything. You don't log in. The snippet you set up once handles every future request.

If your friend ever rotates your token (because you lost your bookmark — see Troubleshooting), come back to your dashboard's "Connect Claude" section, grab the fresh snippet, and re-paste it into your same Project / Custom GPT. The username and old snippet shape are unchanged — only the token line differs.

---

## Troubleshooting

### "I closed the Welcome page without saving anything."

If you saved the dashboard URL anywhere (password manager, notes, email), you're fine — just open it. If not, text the friend who invited you and ask them to rotate your token. They'll send you a fresh dashboard URL.

### "I lost my bookmark and have no backup."

Same as above. The token in the URL is your password. Whoever runs the Hangout worker (the friend who invited you, in most cases) can mint you a fresh token via their admin endpoint, then text you the new URL. Old token immediately stops working.

### "My friends see times in their timezone but I see mine — is that right?"

Yes, intentional. Each user has their own timezone setting, and clock displays render in the *viewer's* timezone. So when you look at a friend's location, the time shown is in *your* zone, not theirs.

To change your own timezone (default is `America/Chicago`), use your dashboard's **Settings** section — type an IANA timezone name (`America/Los_Angeles`, `America/New_York`, `Europe/London`, `Asia/Tokyo`, etc.) and click Update.

### "I want to hide for a while without deleting my account."

Click **Go silent** on your dashboard. One tap — clears your location and turns Public off. To resume, just set a new location later.

### "I want to delete my account entirely."

There's no button for this — it's a deliberate URL you have to type, to avoid accidental clicks. Visit (replacing the placeholders with your own username and token):

```
<your-dashboard-host>/delete?u=<you>&t=<your-token>&confirm=yes
```

⚠️ Permanent. Your username is freed, your token stops working, and you're removed from every friend's allowlist automatically. No undo.

If you just want a break, use Go silent instead.

### "I forgot a friend's username."

Their username is whatever they picked at signup. If you have them on your allowlist, the dashboard shows it. If not, ask them.

---

## Advanced — Claude Code (developers only)

Skip this section unless you already use Claude Code (the command-line tool that runs `claude` in a terminal) and know what `~/.claude/commands/` is.

The slash-command pattern is the cleanest setup for Claude Code — explicit invocation (`/hangout ...`), zero misfire risk, no Pro plan needed.

Save the following to `~/.claude/commands/hangout.md`, filling in the three lines from the snippet:

```markdown
---
description: Update or check Hangout locations.
---

Use the Hangout API. My identity:
- Username: <YOUR USERNAME>
- Token: <YOUR TOKEN>
- Base URL: <YOUR WORKER URL>

If $ARGUMENTS sounds like a place ("I'm at X for N hours"), fetch /set?u=<me>&t=<tok>&loc=<place>&hours=<n>.
If $ARGUMENTS is a friend's username, fetch /u/<name>?as=<me>&t=<tok>.
If $ARGUMENTS is "clear", fetch /clear?u=<me>&t=<tok>.
If $ARGUMENTS is "silent" or "hide me", fetch /silent?u=<me>&t=<tok>.
If $ARGUMENTS is "me" or "state", fetch /me?u=<me>&t=<tok>.

Paste the response body back to me verbatim before any commentary.
```

Then in any `claude` session:

```
/hangout I'm at Pershing Cafe for 3 hours
/hangout michael                       # → "michael is at Pershing Cafe (...)"
/hangout clear
/hangout silent
```

(The `<me>` and `<tok>` placeholders in the URL templates are resolved by Claude from the identity block above them in the prompt. If they ever come through literally in a fetched URL, replace them with your actual values inline.)

---

## Privacy & security

- **The token in your URL is your password.** It appears wherever the URL appears — bookmarks, browser history, Cloudflare access logs, any chat conversation you ran the AI integration through, any screenshot. Treat it that way. Don't reuse it elsewhere.
- **Don't paste the Claude snippet anywhere public.** No screenshots of Project custom instructions. No shared Custom GPTs. The snippet contains your token.
- **Locations only exist for as long as you set them for.** Default 2h, max 24h. After expiry they're invisible to everyone, even if the underlying record stays in storage until you overwrite it.
- **Allowlist is one-way.** If you allowlist someone, *they can see you* — not vice versa. If you want to see them, they need to allowlist you (or flip Public on).
- **No notifications, no DMs, no map, no message history.** Hangout doesn't try to be a chat app. It's "where am I right now," published to a small list.
- **The friend who runs the Hangout worker can read everything.** They have admin access (the `BOOTSTRAP_SECRET`) and can read every user's KV record, rotate any token, or wipe the whole namespace. Trust accordingly — this is a friends-of-friends app, not a privacy guarantee against the host.

---

That's it. If you hit anything weird that this doc doesn't cover, text the friend who invited you.

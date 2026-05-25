# Hangout

Ad-hoc location sharing for friends. One Cloudflare Worker, one KV namespace, ~1k lines.

You set a place ("Pershing Cafe", expires in 2h). Allowlisted friends — or anyone, if you flip public mode — can see it. Update and read from a browser, from Claude on web/phone, or from `curl`. That's it.

(The repo is named `saturday-hangout` as a nod to "Saturday Build" — the day it was built — but the app itself is day-agnostic.)

## Architecture

One Cloudflare Worker (`app.js`), one KV namespace (`STATE`), no client-side JS, no framework, no build step. Server-rendered HTML for the dashboard, plain-text GET API for everything else (so Claude / ChatGPT can drive it with just their web-fetch tool).

For the request-flow diagram, module breakdown, data model, and design tradeoffs, see [architecture.md](architecture.md).

## Prerequisites

- **Node.js** (any version ≥18; you already have it if `node --version` works).
- **A free Cloudflare account.** Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — email + password, no credit card required. Verify the email, skip any prompts to "add a site." The free tier (100k requests/day, 1k KV writes/day) easily covers this app.

## Setup

```sh
git clone https://github.com/adamisom/saturday-hangout.git ~/dev/saturday-hangout
cd ~/dev/saturday-hangout
npm install
```

### 1. Log in to Cloudflare

```sh
npx wrangler login
```

Opens a browser; authorize. Free Cloudflare account is fine.

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create STATE
```

Copy the `id = "..."` it prints, paste it into `wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set the bootstrap secret

This is the one-time secret you'll use to create the very first user (yourself). Pick a random string.

```sh
npx wrangler secret put BOOTSTRAP_SECRET
# (paste a random string when prompted, e.g. `openssl rand -hex 16`)
```

### 4. Deploy

```sh
npx wrangler deploy
```

Wrangler prints the URL: `https://saturday-hangout.<your-account>.workers.dev`. Save this — it's your base URL.

### 5. Create your account

Visit (replacing `YOUR_SECRET` and using your base URL):

```
https://saturday-hangout.<your-account>.workers.dev/bootstrap?s=YOUR_SECRET&u=adam
```

It returns your username + token. **Save the token** — it's your password. Open the dashboard URL it gives you.

### 6. Invite friends

From the dashboard, click **Generate invite link** → send the URL to a friend. They pick a username, get their own token, and you're both auto-allowlisted to see each other.

## Token rotation

A friend lost their bookmark or screenshot of their token? Mint them a new one:

```sh
curl "https://<your-worker>/rotate?s=YOUR_BOOTSTRAP_SECRET&u=<their-username>"
```

The endpoint prints a fresh token and a new `/dashboard?u=…&nonce=…` URL. Send that URL to them — they can re-bookmark it. The old token immediately stops working.

Only the worker owner (you, the holder of `BOOTSTRAP_SECRET`) can call `/rotate`, so you're the recovery authority for everyone you invited. There's no email-based reset — that's the deliberate tradeoff for keeping the data model schema-free.

**Tell friends at signup:** save the dashboard URL to a password manager, notes app, or send-it-to-yourself email *as well as* bookmarking it. The bookmark is convenient; the second copy is the safety net.

## For friends you're inviting

[for-friends.md](for-friends.md) is the friend-facing onboarding guide — designed to be pasted into a GitHub Gist and shared. It covers their day-one signup, the browser-bookmark path, the optional Claude / ChatGPT integration (with the sandboxing rule), day-N usage, troubleshooting, and security notes. Send the Gist URL alongside the invite link.

For *your* setup (deploying, generating invites, rotating tokens), the sections above cover everything you need.

## Local dev

```sh
npm run dev
```

Runs on `http://localhost:8787` with a local KV store. Use `?s=anything&u=adam` against your local bootstrap — wrangler reads `BOOTSTRAP_SECRET` from `.dev.vars` if you create one:

```sh
echo 'BOOTSTRAP_SECRET=dev-secret' > .dev.vars
```

## Endpoints

All GET. Plain-text responses except HTML pages.

| Endpoint | Purpose |
|---|---|
| `/` | Landing + login form |
| `/dashboard?u=&nonce=` | HTML dashboard |
| `/set?u=&nonce=&loc=&hours=` | Set my location |
| `/clear?u=&nonce=` | Clear my location |
| `/me?u=&nonce=` | My current state |
| `/u/<name>?as=&nonce=` | View someone's location (or public) |
| `/allow?u=&nonce=&friend=` | Add to my allowlist |
| `/disallow?u=&nonce=&friend=` | Remove from my allowlist |
| `/public?u=&nonce=&on=1\|0` | Toggle public mode |
| `/silent?u=&nonce=` | Clear location + turn public off in one call |
| `/tz?u=&nonce=&tz=<IANA>` | Set my timezone for time formatting |
| `/delete?u=&nonce=&confirm=yes` | Permanently delete my account (cascades through everyone's allowlist) |
| `/invite?u=&nonce=` | Generate single-use invite link (7-day expiry) |
| `/join?invite=` | Friend's signup page |
| `/signup?invite=&u=` | Claim a username |
| `/claude?u=&nonce=` | Claude/ChatGPT setup snippet — HTML page with one-click copy button + install instructions |
| `/bootstrap?s=&u=` | One-time admin user creation |
| `/rotate?s=&u=` | Admin token rotation (recovery) |
| `/lineage?s=` | Admin: print the invite graph as a text tree (roots = depth-0 users, edges = consumed invites, pending listed separately) |

## Notes

- Locations auto-expire (default 2h, max 24h). Expiry is checked at read time, no cron.
- Invites auto-expire after 7 days. After that they return "expired" and need to be regenerated.
- Allowlist is one-way: if Adam allowlists Michael, Michael can see Adam — not vice versa unless Michael also allowlists Adam. Invite signup auto-allowlists both ways.
- Deleting your account is permanent and cascades — your username is removed from every other user's allowlist.
- Time formatting uses your saved timezone (default `America/Chicago`). When you view a friend, the time renders in *your* tz, not theirs.
- The dashboard auto-refreshes every 60 seconds so friends' updates appear without a manual reload.
- Dashboard write actions keep you on the dashboard (no plain-text confirmation page). Programmatic callers (Claude, curl) still get plain text — unchanged.
- KV is eventually consistent; in practice updates show up in <1s for everyone.
- Token-in-URL means tokens appear in Cloudflare's access logs. Fine for a friends app; don't reuse the token anywhere else.
- **Invite chain is capped at 3 hops.** The worker owner is depth 0; each invite hop adds 1. A user at depth 3 (worker owner → invitee → invitee → invitee) cannot generate further invites. This caps transitive trust — if a friend invites a friend who invites a bot, the bot can't recruit more bots.

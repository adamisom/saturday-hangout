// Hangout — ad-hoc location sharing for friends.
// Single Cloudflare Worker. KV namespace `STATE`. Secret `BOOTSTRAP_SECRET`.
// Architecture, modules, and design tradeoffs: architecture.md.

const RESERVED = new Set([
  'set', 'clear', 'u', 'allow', 'disallow', 'public', 'signup', 'invite',
  'me', 'friends', 'join', 'dashboard', 'claude', 'bootstrap', 'admin', 'api',
  'rotate', 'delete', 'silent', 'tz', 'links', 'save-preset', 'delete-preset',
]);

// Caps transitive trust: 0 = worker owner; each invite hop adds 1.
const MAX_INVITE_DEPTH = 3;

const HTML_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hangout</title>
<style>
  * { box-sizing: border-box; }
  body { font: 16px/1.4 system-ui, -apple-system, sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1, h2 { font-weight: 600; margin-top: 1.5rem; }
  h1 { margin-top: 0; }
  form { margin: 0.75rem 0; }
  label { display: block; margin: 0.5rem 0 0.2rem; font-size: 0.9em; color: #555; }
  input[type=text], input[type=number] { width: 100%; padding: 0.5rem; border: 1px solid #bbb; border-radius: 4px; font-size: 1em; }
  button { padding: 0.5rem 1rem; background: #222; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1em; }
  button.secondary { background: #888; }
  a.btn { text-decoration: none; }
  .friend { padding: 0.6rem 0.75rem; border: 1px solid #eee; border-radius: 6px; margin: 0.4rem 0; }
  .friend .name { font-weight: 600; }
  .friend .loc { color: #333; }
  .friend .empty { color: #aaa; font-style: italic; }
  pre { background: #f4f4f4; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; word-break: break-all; }
  code { background: #f4f4f4; padding: 0 0.25rem; border-radius: 3px; font-size: 0.85em; }
  .row { display: flex; gap: 0.5rem; align-items: stretch; }
  .row > input { flex: 1; }
  .small { font-size: 0.85em; color: #666; }
  a { color: #06c; }
  hr { border: none; border-top: 1px solid #eee; margin: 1.5rem 0; }
</style>
</head>
<body>`;

const HTML_FOOT = `</body></html>`;

function html(body, status = 200, refreshSeconds = 0, refreshUrl = '') {
  let head = HTML_HEAD;
  if (refreshSeconds) {
    const content = refreshUrl ? `${refreshSeconds};url=${refreshUrl}` : String(refreshSeconds);
    head = head.replace('</head>', `<meta http-equiv="refresh" content="${content}"></head>`);
  }
  return new Response(head + body + HTML_FOOT, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function err(msg, status = 400) {
  return text(`Error: ${msg}\n`, status);
}

// Success response for dashboard write actions. With return=dashboard in the
// query, 303-redirects to the dashboard so the user stays in the dashboard view
// after clicking a form/link there. Otherwise returns plain text, same as
// Claude/curl/programmatic clients have always expected.
function actionResponse(message, q) {
  if (q.get('return') === 'dashboard') {
    const u = q.get('u');
    const t = tokenOf(q);
    const dashUrl = `/dashboard?u=${encodeURIComponent(u)}&nonce=${encodeURIComponent(t)}`;
    return new Response(null, { status: 303, headers: { 'Location': dashUrl } });
  }
  return text(message + '\n');
}

// Error counterpart to actionResponse — keeps the user on the dashboard for
// validation/business-logic failures from form submissions. With return=dashboard,
// 303-redirects to /dashboard?...&error=<msg> and the dashboard renders the error
// as a banner. Without return=dashboard, falls through to plain-text err() so
// curl/Claude get the same shape they always did. Auth errors don't go through
// here — those callers don't have return context.
function actionError(msg, q, status = 400) {
  if (q.get('return') === 'dashboard') {
    const u = q.get('u');
    const t = tokenOf(q);
    const dashUrl = `/dashboard?u=${encodeURIComponent(u)}&nonce=${encodeURIComponent(t)}&error=${encodeURIComponent(msg)}`;
    return new Response(null, { status: 303, headers: { 'Location': dashUrl } });
  }
  return err(msg, status);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Inline JS for "Copy" buttons. Pages with a copy button include ${copyScript()}
// once; each button calls copy(this, '<id-of-pre>', '<original label>').
function copyScript() {
  return `<script>
    function copy(btn, targetId, label) {
      var text = document.getElementById(targetId).innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function(){
          btn.textContent = 'Copied!';
          setTimeout(function(){ btn.textContent = label; }, 2000);
        }).catch(function(){
          btn.textContent = 'Copy failed — select manually';
        });
      } else {
        var range = document.createRange();
        range.selectNode(document.getElementById(targetId));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        btn.textContent = 'Selected — press ⌘-C';
      }
    }
  </script>`;
}

function genToken() {
  // 6 bytes / 12 hex chars / 48 bits — friends-app-grade entropy (~280 trillion
  // combinations). Kept short on purpose so the value doesn't pattern-match as
  // a credential in AI-assistant URL fetchers (Anthropic's web_fetch in Claude
  // Chat strips `t=<long hex>` patterns; even with the `?nonce=` rename, a
  // shorter value reduces the chance of similar heuristics tripping).
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function genInvite() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function nowIso() { return new Date().toISOString(); }

function fmtRelative(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m left` : `${h}h left`;
}

function fmtClock(iso, tz) {
  tz = tz || 'America/Chicago';
  const time = new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(iso))
    .find(p => p.type === 'timeZoneName')?.value || tz;
  return `${time} ${abbr}`;
}

function validUsername(name) {
  return /^[a-z0-9-]{3,20}$/.test(name) && !RESERVED.has(name);
}

async function getUser(env, username) {
  const raw = await env.STATE.get(`user:${username}`);
  return raw ? JSON.parse(raw) : null;
}

async function putUser(env, username, data) {
  await env.STATE.put(`user:${username}`, JSON.stringify(data));
}

// Direct token compare — hashing wouldn't help here since the token travels in
// every URL anyway, so the leak surface is the URL itself, not the stored value.
async function authUser(env, u, t) {
  if (!u || !t) return null;
  const user = await getUser(env, u);
  if (!user || user.token !== t) return null;
  return user;
}

// Token query-param accessor. Reads `?nonce=` — was originally `?t=`, renamed
// because Anthropic's managed web_fetch tool (in Claude Chat Desktop /
// Claude.ai web) pattern-matches `t=<long hex>` as a credential and strips it,
// which made every request 401 from the chat path. `nonce` is a cryptographic
// word but isn't on the common-credential-name list those redactors use.
function tokenOf(q) {
  return q.get('nonce');
}

// Expiry is checked at read time, not via a cron — expired entries just sit until
// overwritten on the next /set. Keeps the data model trivial.
function activeLocation(user) {
  const loc = user.location;
  if (!loc) return null;
  if (new Date(loc.expiresAt).getTime() <= Date.now()) return null;
  return loc;
}

function claudeSnippet(base, username, token) {
  return `You are connected to ${username}'s Hangout app.

# Identity (keep this snippet private — the token is effectively a password)
Username: ${username}
Token: ${token}
Base URL: ${base}

# Setup — on your first response in this chat, do this once
Silently load this URL:
  ${base}/links?u=${username}&nonce=${token}

It returns a menu of fully-formed URLs you'll need: friend lookups, my saved places, allow/disallow per friend, public on/off, clear, silent, /me. Hold them in mind for the rest of the chat. Do NOT paste the /links response back to me — it's for your reference, not mine.

Reload /links any time I mention adding a new friend, saving a new place, or if a URL you have stops working (token rotation, etc.).

# Response rule for everything else
When you use an action URL (/set, /clear, /silent, /allow, /disallow, /public, /me, /u/<friend>, /save-preset, /delete-preset), paste the response body back to me verbatim before any commentary. The endpoint replies are conversational and include precise times — don't summarize, don't rephrase. Only /links is for your eyes only.

# What I can ask you to do
Update where I am (with optional hours), check on a friend, go silent or just clear, toggle public mode, add or remove someone from my allowlist, save a place as a preset (or delete one), and show my current status. The URLs for all of these live in /links — use the relevant one when I ask. For things that don't fit the chat path (timezone, invite links, account deletion), I'll use the dashboard — just remind me.

# Status check (always allowed; URL is fully formed)
  ${base}/me?u=${username}&nonce=${token}

# Setting a NEW location that isn't in my saved places
The chat host (Claude Chat Desktop, claude.ai web, or ChatGPT) only lets you reach URLs that already appeared in our conversation — it'll refuse a URL you build with my brand-new place name in it. So:
1. Construct: ${base}/set?u=${username}&nonce=${token}&loc=<urlencoded place>&hours=<n, default 2>
2. Paste it into the chat and ask me to paste it back once so the host authorizes it.
3. After I paste, use it. The response will include a fully-formed "save this place" URL. Offer to use that one too ("want me to save this place so it's one chat message next time?"). If I say yes, use it — no second paste needed, since the URL came from your tool result.

(Saved places I've already added live in /links and don't need this dance — use their /set URL directly.)

URL-encode the place. Hours can be a decimal (e.g. 1.5).

# Full user-facing docs
For dashboard features, timezone changes, account deletion, troubleshooting:
  https://github.com/adamisom/saturday-hangout/blob/main/for-friends.md
`;
}

export default {
  async fetch(request, env) {
    // Defend against `&amp;` leaking into URLs when users copy the snippet from
    // the /claude page — `<pre id="snippet">` is HTML-escaped, and some
    // clipboard / chat-app paths preserve the entity literally instead of
    // decoding it. Without this, `?u=adam&amp;t=...` parses as `u=adam` plus
    // `amp;t=...`, the token is missing, and every action returns 401.
    const cleanUrl = request.url.replace(/&amp;/g, '&');
    const url = new URL(cleanUrl);
    const path = url.pathname;
    const q = url.searchParams;
    const base = `${url.protocol}//${url.host}`;

    try {
      if (path === '/') return landing();
      if (path === '/dashboard') return dashboard(env, q);
      if (path === '/set') return setLocation(env, q, base);
      if (path === '/clear') return clearLocation(env, q);
      if (path === '/me') return showMe(env, q);
      if (path === '/links') return showLinks(env, q, base);
      if (path === '/save-preset') return savePreset(env, q);
      if (path === '/delete-preset') return deletePreset(env, q);
      if (path === '/allow') return allow(env, q);
      if (path === '/disallow') return disallow(env, q);
      if (path === '/public') return setPublic(env, q);
      if (path === '/silent') return goSilent(env, q);
      if (path === '/tz') return setTz(env, q);
      if (path === '/invite') return makeInvite(env, q, base);
      if (path === '/join') return joinPage(env, q);
      if (path === '/signup') return signup(env, q, base);
      if (path === '/claude') return claudeInstructions(env, q, base);
      if (path === '/bootstrap') return bootstrap(env, q);
      if (path === '/rotate') return rotateToken(env, q);
      if (path === '/lineage') return lineage(env, q);
      if (path === '/delete') return deleteAccount(env, q);
      if (path.startsWith('/u/')) {
        const rest = path.slice(3);
        if (!rest || rest.includes('/')) return text('Not found\n', 404);
        return viewUser(env, decodeURIComponent(rest).toLowerCase(), q);
      }
      return text('Not found\n', 404);
    } catch (e) {
      return err(`Server error: ${e.message}`, 500);
    }
  },
};

function landing() {
  return html(`
    <h1>Hangout</h1>
    <p>Ad-hoc location sharing for friends.</p>
    <form action="/dashboard" method="get">
      <label>Username</label>
      <input type="text" name="u" required autocomplete="username">
      <label>Token</label>
      <input type="text" name="nonce" required autocomplete="current-password">
      <p><button>Open dashboard</button></p>
    </form>
    <p class="small">No account? You need an invite link from a friend.</p>
  `);
}

async function dashboard(env, q) {
  const me = (q.get('u') || '').toLowerCase();
  const tok = tokenOf(q);
  const user = await authUser(env, me, tok);
  if (!user) return html('<h1>Invalid login</h1><p><a href="/">Back</a></p>', 401);
  const tz = user.tz || 'America/Chicago';

  const loc = activeLocation(user);
  const locBlock = loc
    ? `<p><strong>${escapeHtml(loc.text)}</strong> — ${fmtRelative(loc.expiresAt)} (until ${fmtClock(loc.expiresAt, tz)})</p>`
    : `<p class="small">No active location.</p>`;

  // O(N) scan of all users to find ones visible to me. Fine up to a few hundred;
  // past that, add a 'subscribers:<name>' reverse index.
  // See architecture.md → "Design choices and tradeoffs".
  const all = await env.STATE.list({ prefix: 'user:' });
  const friends = [];
  for (const key of all.keys) {
    const name = key.name.slice(5);
    if (name === me) continue;
    const u = JSON.parse(await env.STATE.get(key.name));
    const visible = u.public || (u.allowlist || []).includes(me);
    if (!visible) continue;
    friends.push({ name, loc: activeLocation(u) });
  }
  // Active locations first, then alphabetical
  friends.sort((a, b) => {
    if (!!a.loc !== !!b.loc) return a.loc ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const friendsHtml = friends.length === 0
    ? '<p class="small">No friends visible yet. Have them allowlist you, or invite some.</p>'
    : friends.map(f => `
      <div class="friend">
        <div class="name">${escapeHtml(f.name)}</div>
        ${f.loc
          ? `<div class="loc">${escapeHtml(f.loc.text)} <span class="small">(${fmtRelative(f.loc.expiresAt)}, until ${fmtClock(f.loc.expiresAt, tz)})</span></div>`
          : `<div class="empty">no location</div>`}
      </div>
    `).join('');

  const allowlist = (user.allowlist || []).length
    ? (user.allowlist || []).map(n => `${escapeHtml(n)} <a href="/disallow?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&friend=${encodeURIComponent(n)}&return=dashboard" class="small">[remove]</a>`).join(', ')
    : '<span class="small">empty</span>';

  // Saved places: short list of name→place pairs the user can update their
  // location to with one fetch. Exists primarily to make the Claude/ChatGPT
  // chat path work for places that aren't enumerable in advance — see /links
  // commentary. Dashboard users can update directly via the "Where I am" form
  // above, so this section is mostly for AI chat usage.
  const presets = (user.presets || []);
  const presetsHtml = presets.length
    ? presets.map(p => `
        <div class="friend">
          <span class="name">${escapeHtml(p.name)}</span>${p.name !== p.loc ? ` → ${escapeHtml(p.loc)}` : ''}
          <a href="/delete-preset?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&name=${encodeURIComponent(p.name)}&return=dashboard" class="small">[remove]</a>
        </div>
      `).join('')
    : '<p class="small">No saved places yet. Add one below — saved places are what make the Claude/ChatGPT chat path comfortable for the spots you visit often (one chat message and you\'re done).</p>';

  // Auto-refresh every 60s so friends' updates show without a manual reload.
  // The refresh URL drops any ?error=… so a flash-error banner fades after one
  // refresh tick instead of sticking around.
  const errorMsg = q.get('error');
  const errorBanner = errorMsg
    ? `<p style="color: #c00; padding: 0.6rem 0.75rem; background: #fee; border: 1px solid #fcc; border-radius: 4px;"><strong>${escapeHtml(errorMsg)}</strong></p>`
    : '';
  const cleanDashUrl = `/dashboard?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}`;
  return html(`
    <h1>Hi, ${escapeHtml(me)}</h1>
    ${errorBanner}

    <h2>Where I am</h2>
    ${locBlock}
    <form action="/set" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="nonce" value="${escapeHtml(tok)}">
      <input type="hidden" name="return" value="dashboard">
      <label>Place</label>
      <input type="text" name="loc" placeholder="Pershing Cafe" required>
      <label>Hours (default 2)</label>
      <input type="number" name="hours" step="0.25" min="0.25" max="24" placeholder="2">
      <p>
        <button>Update location</button>
        ${loc ? `<a class="btn" href="/clear?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&return=dashboard"><button type="button" class="secondary">Clear</button></a>` : ''}
      </p>
    </form>

    <hr>
    <h2>Friends</h2>
    ${friendsHtml}

    <hr>
    <h2>Allowlist <span class="small">(who can see me)</span></h2>
    <p>${allowlist}</p>
    <form action="/allow" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="nonce" value="${escapeHtml(tok)}">
      <input type="hidden" name="return" value="dashboard">
      <div class="row">
        <input type="text" name="friend" placeholder="username">
        <button>Add</button>
      </div>
    </form>

    <hr>
    <h2>Invite a friend</h2>
    <p><a class="btn" href="/invite?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}"><button class="secondary">Generate invite link</button></a></p>

    <hr>
    <h2>Connect Claude / ChatGPT <span class="small">(optional, one-time)</span></h2>
    <p><a href="/claude?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}">Open the setup snippet</a> — paste once at the top of a fresh Claude/ChatGPT chat (any plan, including free), or into a Project/Custom GPT if you have Pro/Plus. Then update your location and check on friends without ever leaving the chat.</p>
    <p class="small">💡 <strong>Tip:</strong> add a few <strong>Saved places</strong> below first — Home, your usual coffee shop, etc.</p>

    <hr>
    <h2>Saved places <span class="small">(AI chat usage)</span></h2>
    ${presetsHtml}
    <form action="/save-preset" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="nonce" value="${escapeHtml(tok)}">
      <input type="hidden" name="return" value="dashboard">
      <label>Place</label>
      <input type="text" name="loc" placeholder="123 Main St" required>
      <label>Short name for AI chat — optional</label>
      <input type="text" name="name" placeholder="home">
      <p><button>Save place</button></p>
    </form>

    <hr>
    <h2>Public mode</h2>
    <p class="small">Currently ${user.public ? '<strong>ON</strong> — anyone with your username can see you' : '<strong>OFF</strong> — only allowlisted friends'}.</p>
    <p>
      <a class="btn" href="/public?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&on=${user.public ? '0' : '1'}&return=dashboard">
        <button class="secondary">Turn ${user.public ? 'off' : 'on'}</button>
      </a>
    </p>

    <hr>
    <h2>Go silent</h2>
    <p class="small">Clear location + turn public off in one click.</p>
    <p>
      <a class="btn" href="/silent?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&return=dashboard">
        <button class="secondary">Go silent</button>
      </a>
    </p>

    <hr>
    <h2>Settings</h2>
    <p>Timezone: <strong>${escapeHtml(tz)}</strong></p>
    <form action="/tz" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="nonce" value="${escapeHtml(tok)}">
      <input type="hidden" name="return" value="dashboard">
      <div class="row">
        <input type="text" name="tz" placeholder="America/Los_Angeles">
        <button>Update</button>
      </div>
    </form>

    <hr>
    <h2>Delete account</h2>
    <p class="small">Permanent. Removes you from everyone's allowlist and invalidates your token.</p>
    <p>
      <a class="btn" href="/delete?u=${encodeURIComponent(me)}&nonce=${encodeURIComponent(tok)}&confirm=yes"
         onclick="return confirm('Permanently delete your account? This cannot be undone — your token will stop working and you will be removed from everyone\\'s allowlist.');">
        <button class="secondary">Delete account…</button>
      </a>
    </p>
  `, 200, 60, cleanDashUrl);
}

// Writes use GET so chat assistants' web-fetch tools (which fire GETs reliably,
// POSTs less so) can drive the app. No CDN cache sits in front, so the usual
// GET-side-effect risks don't apply. See architecture.md → "Design choices".
async function setLocation(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const t = tokenOf(q);
  const user = await authUser(env, u, t);
  if (!user) return err('Invalid token.', 401);
  // Strip control whitespace so /me's line-based format stays parseable. Without
  // this, a pasted multiline string lands a raw \n in the response body and any
  // line-based reader (e.g. Claude via WebFetch) misparses the 5-line contract.
  const loc = (q.get('loc') || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!loc) return actionError('Missing loc.', q);
  if (loc.length > 200) return actionError('Location too long (200 char max).', q);
  let hours = parseFloat(q.get('hours') || '2');
  if (!isFinite(hours) || hours <= 0) hours = 2;
  if (hours > 24) hours = 24;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  user.location = { text: loc, expiresAt };
  await putUser(env, u, user);
  // If this loc isn't already a saved preset, hand back a fully-formed save-preset
  // URL in the response body. Claude Chat's web-fetch policy authorizes URLs that
  // appear in tool results, so this lets the user say "save it" and have Claude
  // fetch the save URL directly — no second copy-paste needed. The name defaults
  // to the loc; user can rename later via the dashboard. Saved presets don't
  // carry hours — the user supplies hours per-call or accepts the /set default
  // of 2 — so the save URL omits hours entirely.
  const presets = user.presets || [];
  const alreadySaved = presets.some(p => p.loc === loc);
  const saveLine = (alreadySaved || !base)
    ? ''
    : `\nSave this place for quick reuse: ${base}/save-preset?u=${u}&nonce=${t}&loc=${encodeURIComponent(loc)}`;
  return actionResponse(`OK. Location set: ${loc} (${hours}h, until ${fmtClock(expiresAt, user.tz)}).${saveLine}`, q);
}

async function clearLocation(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  user.location = null;
  await putUser(env, u, user);
  return actionResponse('OK. Location cleared.', q);
}

async function showMe(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const loc = activeLocation(user);
  const lines = [
    `Username: ${u}`,
    `Public mode: ${user.public ? 'ON' : 'OFF'}`,
    `Timezone: ${user.tz || 'America/Chicago'}`,
    `Allowlist: ${(user.allowlist || []).join(', ') || '(empty)'}`,
    loc
      ? `Location: ${loc.text} (${fmtRelative(loc.expiresAt)}, until ${fmtClock(loc.expiresAt, user.tz)})`
      : `Location: (none)`,
  ];
  return text(lines.join('\n') + '\n');
}

// Returns a flat menu of fully-formed URLs the chat assistant can fetch directly.
// Exists because Claude Chat's web_fetch only authorizes URLs that appeared
// literally in a prior user message or tool result — templates with placeholders
// (/u/<name>, /allow?...&friend=<name>) get rejected after substitution. By
// fetching /links first, the assistant pulls every URL it will need (friend
// lookups, allow/disallow per friend, public toggles, clear, silent, saved
// places) into its conversation history, where they become fetchable. Free-text
// /set for a novel place still needs a one-time copy-paste; saving that place as
// a preset (via the URL /set returns) makes it enumerable from then on.
async function showLinks(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const t = tokenOf(q);
  const user = await authUser(env, u, t);
  if (!user) return err('Invalid token.', 401);

  // Same O(N) visibility scan as dashboard. We want the union of:
  //   (a) people visible to me right now (public OR have me in their allowlist)
  //   (b) people I have in my own allowlist (I may want to look them up even if
  //       they haven't reciprocated; the URL is harmless either way)
  const all = await env.STATE.list({ prefix: 'user:' });
  const visible = new Set();
  for (const key of all.keys) {
    const name = key.name.slice(5);
    if (name === u) continue;
    const other = JSON.parse(await env.STATE.get(key.name));
    if (other.public || (other.allowlist || []).includes(u)) visible.add(name);
  }
  for (const friend of (user.allowlist || [])) visible.add(friend);
  const friendNames = [...visible].sort();
  const lookupLines = friendNames.length
    ? friendNames.map(n => `  ${n}: ${base}/u/${encodeURIComponent(n)}?as=${u}&nonce=${t}`).join('\n')
    : '  (no friends visible yet — get an invite from one or have them allowlist you)';

  const allowed = (user.allowlist || []).slice().sort();
  const disallowLines = allowed.length
    ? allowed.map(n => `  ${n}: ${base}/disallow?u=${u}&nonce=${t}&friend=${encodeURIComponent(n)}`).join('\n')
    : '  (your allowlist is empty)';
  const allowableLines = friendNames.filter(n => !allowed.includes(n))
    .map(n => `  ${n}: ${base}/allow?u=${u}&nonce=${t}&friend=${encodeURIComponent(n)}`).join('\n');

  const presets = user.presets || [];
  const presetLines = presets.length
    ? presets.map(p => `  ${p.name}${p.name !== p.loc ? ` (${p.loc})` : ''}: ${base}/set?u=${u}&nonce=${t}&loc=${encodeURIComponent(p.loc)}`).join('\n')
    : '  (no saved places yet — set a location, then use the "save this place" URL from the /set response)';
  const deletePresetLines = presets.length
    ? presets.map(p => `  ${p.name}: ${base}/delete-preset?u=${u}&nonce=${t}&name=${encodeURIComponent(p.name)}`).join('\n')
    : '';

  const body = `Hangout menu for ${u} — every URL here is fully formed. Fetch the relevant one when the user asks. This is for your internal use; do not paste this whole block back to the user.

## Look up a friend's location
${lookupLines}

## Update my location — saved places
${presetLines}

## Stop sharing
  Clear my location: ${base}/clear?u=${u}&nonce=${t}
  Go silent (clear + public off): ${base}/silent?u=${u}&nonce=${t}

## Public mode
  Turn ON:  ${base}/public?u=${u}&nonce=${t}&on=1
  Turn OFF: ${base}/public?u=${u}&nonce=${t}&on=0

## My own status
  ${base}/me?u=${u}&nonce=${t}

## Allowlist — remove people who can currently see me
${disallowLines}
${allowableLines ? `\n## Allowlist — add visible friends not yet on my list\n${allowableLines}\n` : ''}${deletePresetLines ? `\n## Delete a saved place\n${deletePresetLines}\n` : ''}
Setting a NEW location (not in saved places above): construct ${base}/set?u=${u}&nonce=${t}&loc=<urlencoded place>&hours=<n>, ask me to paste it back so the chat host authorizes it, then use it. The response will include a fully-formed save-preset URL — offer to save the place when you use it.
`;
  return text(body);
}

// Upsert a saved place. Keyed by name (case-sensitive). Name defaults to loc if
// omitted — that's the path taken by the save-preset URL returned in /set, where
// the user hasn't picked a separate short name. Presets are just name→place
// pairs; the user supplies hours per-call ("I'm at home for 4 hours") or accepts
// the /set default of 2.
async function savePreset(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const loc = (q.get('loc') || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!loc) return actionError('Missing loc.', q);
  if (loc.length > 200) return actionError('Location too long (200 char max).', q);
  const name = (q.get('name') || loc).replace(/[\r\n\t]/g, ' ').trim();
  if (!name) return actionError('Missing name.', q);
  if (name.length > 50) return actionError('Preset name too long (50 char max).', q);
  user.presets = user.presets || [];
  // Cap at 20 presets so /links doesn't grow unbounded. Reuse-by-name handles
  // updates without bumping the count.
  const existingIdx = user.presets.findIndex(p => p.name === name);
  if (existingIdx >= 0) {
    user.presets[existingIdx] = { name, loc };
  } else {
    if (user.presets.length >= 20) {
      return actionError('You have 20 saved places already (max). Delete one first.', q);
    }
    user.presets.push({ name, loc });
  }
  user.presets.sort((a, b) => a.name.localeCompare(b.name));
  await putUser(env, u, user);
  return actionResponse(`OK. Saved place "${name}" → ${loc}.`, q);
}

async function deletePreset(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const name = (q.get('name') || '').trim();
  if (!name) return actionError('Missing name.', q);
  const before = (user.presets || []).length;
  user.presets = (user.presets || []).filter(p => p.name !== name);
  if (user.presets.length === before) {
    return actionError(`No saved place named "${name}".`, q, 404);
  }
  await putUser(env, u, user);
  return actionResponse(`OK. Deleted saved place "${name}".`, q);
}

async function viewUser(env, target, q) {
  if (!target) return err('Missing target user.');
  const viewer = (q.get('as') || '').toLowerCase();
  const vtoken = tokenOf(q);
  // Authenticate the viewer up front — we need their tz for time formatting plus
  // their identity for the allowlist + self-view checks.
  const viewerObj = (viewer && vtoken) ? await authUser(env, viewer, vtoken) : null;
  const user = await getUser(env, target);
  // Same response whether the user doesn't exist or just isn't visible — keeps a
  // probe from leaking which usernames are registered.
  if (!user) return text(`${target}'s location is not shared with you.\n`, 403);
  let allowed = false;
  if (user.public) allowed = true;
  // Self-view: looking up your own location works without needing yourself in
  // your own allowlist.
  else if (viewerObj && viewer === target) allowed = true;
  else if (viewerObj && (user.allowlist || []).includes(viewer)) allowed = true;
  if (!allowed) return text(`${target}'s location is not shared with you.\n`, 403);
  const tz = viewerObj?.tz || 'America/Chicago';
  const loc = activeLocation(user);
  if (!loc) return text(`${target} has no active location.\n`);
  return text(`${target} is at ${loc.text} (${fmtRelative(loc.expiresAt)}, until ${fmtClock(loc.expiresAt, tz)}).\n`);
}

async function allow(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const friend = (q.get('friend') || '').trim().toLowerCase();
  if (!friend) return actionError('Missing friend.', q);
  // Self-add is meaningless (viewUser already lets you see your own location
  // without being in your own allowlist) and confusing UX. Block it explicitly.
  if (friend === u) return actionError("You can't add yourself to your own allowlist.", q);
  // Reject unknown usernames so the allowlist can't accumulate ghost entries
  // (e.g. typos). Disclosing existence is fine here — this endpoint is
  // auth-gated, only allowlisted/invited users ever hit it.
  if (!(await getUser(env, friend))) return actionError(`No such user: ${friend}.`, q, 404);
  user.allowlist = user.allowlist || [];
  if (!user.allowlist.includes(friend)) user.allowlist.push(friend);
  await putUser(env, u, user);
  return actionResponse(`OK. ${friend} can now see your location.`, q);
}

async function disallow(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const friend = (q.get('friend') || '').trim().toLowerCase();
  if (!friend) return actionError('Missing friend.', q);
  user.allowlist = (user.allowlist || []).filter(x => x !== friend);
  await putUser(env, u, user);
  return actionResponse(`OK. ${friend} can no longer see your location.`, q);
}

async function setPublic(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  user.public = q.get('on') === '1';
  await putUser(env, u, user);
  return actionResponse(`OK. Public mode: ${user.public ? 'ON' : 'OFF'}.`, q);
}

async function goSilent(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  user.location = null;
  user.public = false;
  await putUser(env, u, user);
  return actionResponse(`OK. Going silent: location cleared, public mode OFF.`, q);
}

async function setTz(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const tz = (q.get('tz') || '').trim();
  if (!tz) return actionError('Missing tz. Use an IANA name like America/Los_Angeles.', q);
  try {
    new Intl.DateTimeFormat([], { timeZone: tz });
  } catch (e) {
    return actionError(`Invalid timezone: ${tz}. Use an IANA name like America/Los_Angeles.`, q);
  }
  user.tz = tz;
  await putUser(env, u, user);
  return actionResponse(`OK. Timezone set to ${tz}.`, q);
}

// Invites carry a 7-day expiry so stale links can't be redeemed months later.
// They also snapshot the inviter's depth so signup can compute the new user's
// depth even if the inviter is deleted between invite creation and use.
async function makeInvite(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  const depth = user.depth ?? 0;
  if (depth >= MAX_INVITE_DEPTH) {
    return err(`Invite chain limit reached: your invitees would be ${depth + 1} hops from the worker owner (max ${MAX_INVITE_DEPTH}). Ask someone closer in the chain to invite your friend instead.`, 403);
  }
  const code = genInvite();
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await env.STATE.put(`invite:${code}`, JSON.stringify({
    from: u, inviterDepth: depth, used: false, createdAt: nowIso(), expiresAt,
  }));
  const url = `${base}/join?invite=${code}`;
  const tz = user.tz || 'America/Chicago';
  const expiryDate = new Date(expiresAt).toLocaleDateString('en-US', {
    timeZone: tz, month: 'short', day: 'numeric',
  });
  return html(`
    <h1>Invite link</h1>
    <p>Send this to your friend:</p>
    <pre id="invite-url">${escapeHtml(url)}</pre>
    <p><button onclick="copy(this, 'invite-url', 'Copy link')">Copy link</button></p>
    <p class="small">Single-use. Expires ${escapeHtml(expiryDate)} (7 days from now).</p>
    <p><a href="/dashboard?u=${encodeURIComponent(u)}&nonce=${encodeURIComponent(tokenOf(q))}">Go to Dashboard</a></p>
    ${copyScript()}
  `);
}

// Renders the join/signup form. Used by /join (fresh load) and by /signup when
// username validation fails — so users see the error inline with the input
// pre-filled, instead of a plain-text error page that requires hitting Back.
function joinForm(code, inviterName, opts = {}) {
  const { error = null, prefillName = '' } = opts;
  const errorBlock = error
    ? `<p style="color: #c00; margin: 0.75rem 0;"><strong>${escapeHtml(error)}</strong></p>`
    : '';
  return `
    <h1>Join Hangout</h1>
    <p>Invited by <strong>${escapeHtml(inviterName)}</strong>.</p>
    ${errorBlock}
    <form action="/signup" method="get">
      <input type="hidden" name="invite" value="${escapeHtml(code)}">
      <label>Pick a username (3–20 chars, lowercase letters/digits/dashes)</label>
      <input type="text" name="u" required pattern="[a-z0-9-]{3,20}" value="${escapeHtml(prefillName)}" autofocus>
      <p><button>Claim it</button></p>
    </form>
  `;
}

async function joinPage(env, q) {
  const code = q.get('invite');
  if (!code) return html('<h1>Missing invite code.</h1>', 400);
  const raw = await env.STATE.get(`invite:${code}`);
  if (!raw) return html('<h1>Invalid invite code.</h1>', 404);
  const inv = JSON.parse(raw);
  if (inv.used) return html('<h1>This invite has already been used.</h1>', 410);
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() <= Date.now()) {
    return html('<h1>This invite has expired.</h1><p>Ask the sender to generate a new one.</p>', 410);
  }
  return html(joinForm(code, inv.from));
}

// On signup, the new user and the inviter automatically allow each other —
// otherwise they couldn't see each other's locations until both clicked through
// the allowlist UI. Either can revoke later.
async function signup(env, q, base) {
  const code = q.get('invite');
  const name = (q.get('u') || '').toLowerCase().trim();
  if (!code) return err('Missing invite.');
  // Fetch the invite up front so username-related errors below can re-render the
  // join form (which needs inv.from to say "Invited by X").
  const raw = await env.STATE.get(`invite:${code}`);
  if (!raw) return err('Invalid invite code.', 404);
  const inv = JSON.parse(raw);
  if (inv.used) return err('Invite already used.', 410);
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() <= Date.now()) {
    return err('Invite has expired.', 410);
  }
  if (!validUsername(name)) {
    return html(joinForm(code, inv.from, {
      error: 'Invalid username — must be 3–20 lowercase letters/digits/dashes, and not a reserved word.',
      prefillName: name,
    }), 400);
  }
  if (await getUser(env, name)) {
    // Suggest the first available `${name}<n>` for n in 2..5. Cheap: usually 1 KV
    // read since the first candidate is typically free in a small friend group.
    let suggestion = null;
    for (let i = 2; i <= 5; i++) {
      const candidate = `${name}${i}`;
      if (validUsername(candidate) && !(await getUser(env, candidate))) {
        suggestion = candidate;
        break;
      }
    }
    return html(joinForm(code, inv.from, {
      error: `Username already taken.${suggestion ? ` Try "${suggestion}" instead.` : ''}`,
      prefillName: suggestion || name,
    }), 400);
  }

  const token = genToken();
  const newUser = {
    token,
    allowlist: [inv.from],
    public: false,
    location: null,
    tz: 'America/Chicago',
    depth: (inv.inviterDepth ?? 0) + 1,
    createdAt: nowIso(),
  };
  await putUser(env, name, newUser);

  const inviter = await getUser(env, inv.from);
  if (inviter) {
    inviter.allowlist = inviter.allowlist || [];
    if (!inviter.allowlist.includes(name)) inviter.allowlist.push(name);
    await putUser(env, inv.from, inviter);
  }

  await env.STATE.put(`invite:${code}`, JSON.stringify({
    ...inv, used: true, usedBy: name, usedAt: nowIso(),
  }));

  return html(`
    <h1>Welcome, ${escapeHtml(name)}!</h1>
    <p>You and <strong>${escapeHtml(inv.from)}</strong> can now see each other.</p>

    <p>Your dashboard URL:</p>
    <pre id="dashboard-url">${base}/dashboard?u=${escapeHtml(name)}&nonce=${escapeHtml(token)}</pre>
    <p><button onclick="copy(this, 'dashboard-url', 'Copy URL')">Copy URL</button></p>

    <p><a class="btn" href="/dashboard?u=${encodeURIComponent(name)}&nonce=${encodeURIComponent(token)}"><button>Go to Dashboard</button></a></p>

    <hr>
    <p class="small">First time? Read <a href="https://github.com/adamisom/saturday-hangout/blob/main/for-friends.md" target="_blank" rel="noopener noreferrer">for-friends.md</a> — covers saving your URL, phone home-screen, the optional Claude/ChatGPT chat path, and troubleshooting.</p>
    <p class="small">Or jump straight to: <a href="/claude?u=${encodeURIComponent(name)}&nonce=${encodeURIComponent(token)}" target="_blank" rel="noopener noreferrer">get your Claude/ChatGPT setup snippet</a> (your token is pre-filled).</p>
    ${copyScript()}
  `);
}

async function claudeInstructions(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const t = tokenOf(q);
  const user = await authUser(env, u, t);
  if (!user) return err('Invalid token.', 401);
  // HTML wrapper around the same snippet so users get a one-click Copy button + a
  // plain-language explainer. The raw snippet text lives in <pre id="snippet">.
  const snippet = claudeSnippet(base, u, t);
  return html(`
    <h1>Connect Hangout to Claude or ChatGPT</h1>
    <p>Paste this snippet <strong>once</strong> at the top of a fresh chat in Claude or ChatGPT — then update your location and check on friends without ever leaving that chat. <strong>Works on any plan, including free tier.</strong></p>
    <p>After setup you can say things like:</p>
    <ul>
      <li><em>"I'm at Pershing Cafe for two hours."</em></li>
      <li><em>"Where is sanya?"</em></li>
      <li><em>"Go silent, heading home."</em></li>
    </ul>
    <p>Claude or ChatGPT will hit your Hangout URL behind the scenes and tell you what it found.</p>
    <p><strong>Add your usual places first.</strong> On your dashboard, scroll to "Saved places" and add a couple — home, your coffee shop, the office. Then saying <em>"I'm at home"</em> in chat works in one message. The first time you mention a brand-new place, the chat will print a URL and ask you to paste it back — takes a couple seconds. You can also tell the chat to <em>"save it"</em> and it'll be in your list next time.</p>
    <h2>How to install</h2>
    <ol>
      <li>Click <strong>Copy snippet</strong> below.</li>
      <li><strong>Simplest (any plan):</strong> open Claude Chat (Desktop) or claude.ai in a browser — or chatgpt.com — → start a fresh chat → paste the snippet as your first message → bookmark or pin that chat. From now on just return to that one chat to use Hangout.</li>
      <li><strong>If you have Claude.ai Pro or ChatGPT Plus:</strong> paste the snippet into a Project's custom instructions (Claude) or a Custom GPT's instructions (ChatGPT) instead. Every new chat inside inherits the setup; syncs cleanly to mobile. (ChatGPT: also enable Web Browsing.)</li>
    </ol>
    <p class="small"><strong>Keep this snippet private.</strong> Your token is in it — anyone who has the token can post as you. Treat it like a password.</p>
    <p class="small"><strong>Claude Code users (developers):</strong> the chat-snippet path above doesn't fit Claude Code well. Use the <code>~/.claude/commands/hangout.md</code> slash-command path instead — see for-friends.md, "Advanced — Claude Code" section.</p>
    <p><button onclick="copy(this, 'snippet', 'Copy snippet')">Copy snippet</button></p>
    <pre id="snippet">${escapeHtml(snippet)}</pre>
    <p class="small"><a href="/dashboard?u=${encodeURIComponent(u)}&nonce=${encodeURIComponent(t)}">Go to Dashboard</a></p>
    ${copyScript()}
  `);
}

// First-user bootstrap. /signup requires an invite, but the very first user has
// nobody to invite them — so this endpoint mints their account, gated by
// BOOTSTRAP_SECRET. Run once during deploy; rely on invites after that.
async function bootstrap(env, q) {
  const secret = q.get('s');
  if (!env.BOOTSTRAP_SECRET) return err('BOOTSTRAP_SECRET not set on the worker.', 500);
  if (!secret || secret !== env.BOOTSTRAP_SECRET) return err('Forbidden.', 403);
  const name = (q.get('u') || '').toLowerCase().trim();
  if (!validUsername(name)) return err('Invalid username (3–20 lowercase chars/digits/dashes, not reserved).');
  if (await getUser(env, name)) return err('Username already taken.');
  const token = genToken();
  await putUser(env, name, {
    token, allowlist: [], public: false, location: null,
    tz: 'America/Chicago', depth: 0, createdAt: nowIso(),
  });
  return text(`User created.\nUsername: ${name}\nToken: ${token}\n\nSave the token — it's your password. Open: /dashboard?u=${name}&nonce=${token}\n`);
}

// Admin recovery: when a friend loses their bookmark, the worker owner (holder
// of BOOTSTRAP_SECRET) mints them a fresh token via this endpoint.
async function rotateToken(env, q) {
  const secret = q.get('s');
  if (!env.BOOTSTRAP_SECRET) return err('BOOTSTRAP_SECRET not set on the worker.', 500);
  if (!secret || secret !== env.BOOTSTRAP_SECRET) return err('Forbidden.', 403);
  const name = (q.get('u') || '').toLowerCase().trim();
  if (!name) return err('Missing u (username).');
  const user = await getUser(env, name);
  if (!user) return err(`No such user: ${name}`, 404);
  const newToken = genToken();
  user.token = newToken;
  await putUser(env, name, user);
  return text(`Token rotated for ${name}.\nNew token: ${newToken}\n\nSend them this URL: /dashboard?u=${name}&nonce=${newToken}\n`);
}

// Admin: print the invite graph as a text tree. Roots are depth-0 users
// (bootstrap users that nobody invited). Edges come from consumed invite
// records (from → usedBy). Pending invites listed separately. Deleted-user
// references aren't decorated — names appear as recorded at invite time.
async function lineage(env, q) {
  const secret = q.get('s');
  if (!env.BOOTSTRAP_SECRET) return err('BOOTSTRAP_SECRET not set on the worker.', 500);
  if (!secret || secret !== env.BOOTSTRAP_SECRET) return err('Forbidden.', 403);
  const invKeys = await env.STATE.list({ prefix: 'invite:' });
  const invites = [];
  for (const k of invKeys.keys) {
    const raw = await env.STATE.get(k.name);
    if (raw) invites.push({ code: k.name.slice(7), ...JSON.parse(raw) });
  }
  const consumed = invites.filter(i => i.used);
  const pending = invites.filter(i => !i.used);
  // Build inviter → [{ name, joined }] from consumed invites
  const children = {};
  for (const inv of consumed) {
    (children[inv.from] = children[inv.from] || []).push({
      name: inv.usedBy,
      joined: (inv.usedAt || '').slice(0, 10),
    });
  }
  // Roots: depth-0 users (include even if they haven't invited anyone yet)
  const userKeys = await env.STATE.list({ prefix: 'user:' });
  const roots = [];
  for (const k of userKeys.keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const u = JSON.parse(raw);
    if ((u.depth ?? 0) === 0) roots.push(k.name.slice(5));
  }
  roots.sort();
  function printSubtree(name, prefix, depth) {
    const kids = (children[name] || []).sort((a, b) => a.name.localeCompare(b.name));
    if (!kids.length) return '';
    return kids.map((c, idx) => {
      const isLast = idx === kids.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const line = `${prefix}${connector}${c.name} (depth ${depth + 1}${c.joined ? `, joined ${c.joined}` : ''})`;
      const sub = printSubtree(c.name, prefix + childPrefix, depth + 1);
      return sub ? `${line}\n${sub}` : line;
    }).join('\n');
  }
  const treeText = roots.length
    ? roots.map(r => {
        const sub = printSubtree(r, '', 0);
        return sub ? `${r} (depth 0)\n${sub}` : `${r} (depth 0)`;
      }).join('\n\n')
    : '(no users)';
  let pendingText = '';
  if (pending.length) {
    pendingText = '\n\nPending invites:\n' + pending
      .sort((a, b) => a.from.localeCompare(b.from))
      .map(p => `  ${p.code} from ${p.from} (created ${(p.createdAt || '').slice(0, 10)}, expires ${(p.expiresAt || '').slice(0, 10)})`)
      .join('\n');
  }
  return text(`Invite lineage (${consumed.length} consumed, ${pending.length} pending):\n\n${treeText}${pendingText}\n`);
}

// Permanent. Cascades through every other user's allowlist before deleting the
// record, so dangling references don't accumulate.
async function deleteAccount(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, tokenOf(q));
  if (!user) return err('Invalid token.', 401);
  if (q.get('confirm') !== 'yes') {
    return text(`This will permanently delete the account "${u}".\nTo confirm, re-run with &confirm=yes appended.\n`, 400);
  }
  const all = await env.STATE.list({ prefix: 'user:' });
  for (const key of all.keys) {
    if (key.name === `user:${u}`) continue;
    const other = JSON.parse(await env.STATE.get(key.name));
    const before = (other.allowlist || []).length;
    const after = (other.allowlist || []).filter(x => x !== u);
    if (after.length !== before) {
      other.allowlist = after;
      await env.STATE.put(key.name, JSON.stringify(other));
    }
  }
  await env.STATE.delete(`user:${u}`);
  return text(`Account "${u}" deleted. Your token is no longer valid.\n`);
}

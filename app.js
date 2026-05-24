// Hangout — ad-hoc location sharing for friends.
// Single Cloudflare Worker. KV namespace `STATE`. Secret `BOOTSTRAP_SECRET`.
// Architecture, modules, and design tradeoffs: architecture.md.

const RESERVED = new Set([
  'set', 'clear', 'u', 'allow', 'disallow', 'public', 'signup', 'invite',
  'me', 'friends', 'join', 'dashboard', 'claude', 'bootstrap', 'admin', 'api',
  'rotate', 'delete', 'silent', 'tz',
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

function html(body, status = 200, refreshSeconds = 0) {
  const head = refreshSeconds
    ? HTML_HEAD.replace('</head>', `<meta http-equiv="refresh" content="${refreshSeconds}"></head>`)
    : HTML_HEAD;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function genToken() {
  const bytes = new Uint8Array(18);
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

# Response rule
When you fetch a hangout URL below, paste the response body back to me verbatim before adding any commentary. Don't summarize, don't rephrase — the endpoint replies are already conversational and include precise times.

# Identity (keep token private)
Username: ${username}
Token: ${token}
Base URL: ${base}

# When I say where I am
Fetch (GET):
  ${base}/set?u=${username}&t=${token}&loc=<urlencoded place>&hours=<optional, default 2>

# Clear my location
  ${base}/clear?u=${username}&t=${token}

# Where is a friend? (replace <name>)
  ${base}/u/<name>?as=${username}&t=${token}

# Allow / disallow someone to see me
  ${base}/allow?u=${username}&t=${token}&friend=<name>
  ${base}/disallow?u=${username}&t=${token}&friend=<name>

# Toggle public mode (anyone can see me)
  ${base}/public?u=${username}&t=${token}&on=1
  ${base}/public?u=${username}&t=${token}&on=0

# Go silent (clear location + turn public off in one call)
  ${base}/silent?u=${username}&t=${token}

# My own state
  ${base}/me?u=${username}&t=${token}

# Full user-facing docs (for anything not covered above)
For allowlist management, timezone changes, account deletion, troubleshooting, the bookmark-vs-chat path comparison, etc. — read or fetch:
  https://github.com/adamisom/saturday-hangout/blob/main/for-friends.md

URL-encode the place. Hours can be a decimal (e.g. 1.5). Tell me what the endpoint returned.
`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const q = url.searchParams;
    const base = `${url.protocol}//${url.host}`;

    try {
      if (path === '/') return landing();
      if (path === '/dashboard') return dashboard(env, q);
      if (path === '/set') return setLocation(env, q);
      if (path === '/clear') return clearLocation(env, q);
      if (path === '/me') return showMe(env, q);
      if (path === '/allow') return allow(env, q);
      if (path === '/disallow') return disallow(env, q);
      if (path === '/public') return setPublic(env, q);
      if (path === '/silent') return goSilent(env, q);
      if (path === '/tz') return setTz(env, q);
      if (path === '/invite') return makeInvite(env, q, base);
      if (path === '/join') return joinPage(env, q);
      if (path === '/signup') return signup(env, q);
      if (path === '/claude') return claudeInstructions(env, q, base);
      if (path === '/bootstrap') return bootstrap(env, q);
      if (path === '/rotate') return rotateToken(env, q);
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
      <input type="text" name="t" required autocomplete="current-password">
      <p><button>Open dashboard</button></p>
    </form>
    <p class="small">No account? You need an invite link from a friend.</p>
  `);
}

async function dashboard(env, q) {
  const me = (q.get('u') || '').toLowerCase();
  const tok = q.get('t');
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
    ? (user.allowlist || []).map(n => `${escapeHtml(n)} <a href="/disallow?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}&friend=${encodeURIComponent(n)}" class="small">[remove]</a>`).join(', ')
    : '<span class="small">empty</span>';

  // Auto-refresh every 60s so friends' updates show without a manual reload.
  return html(`
    <h1>Hi, ${escapeHtml(me)}</h1>

    <h2>Where I am</h2>
    ${locBlock}
    <form action="/set" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="t" value="${escapeHtml(tok)}">
      <label>Place</label>
      <input type="text" name="loc" placeholder="Pershing Cafe" required>
      <label>Hours (default 2)</label>
      <input type="number" name="hours" step="0.25" min="0.25" max="24" placeholder="2">
      <p>
        <button>Update location</button>
        ${loc ? `<a class="btn" href="/clear?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}"><button type="button" class="secondary">Clear</button></a>` : ''}
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
      <input type="hidden" name="t" value="${escapeHtml(tok)}">
      <div class="row">
        <input type="text" name="friend" placeholder="username">
        <button>Add</button>
      </div>
    </form>

    <hr>
    <h2>Invite a friend</h2>
    <p><a class="btn" href="/invite?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}"><button class="secondary">Generate invite link</button></a></p>

    <hr>
    <h2>Public mode</h2>
    <p class="small">Currently ${user.public ? '<strong>ON</strong> — anyone with your username can see you' : '<strong>OFF</strong> — only allowlisted friends'}.</p>
    <p>
      <a class="btn" href="/public?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}&on=${user.public ? '0' : '1'}">
        <button class="secondary">Turn ${user.public ? 'off' : 'on'}</button>
      </a>
    </p>

    <hr>
    <h2>Go silent</h2>
    <p class="small">Clear location + turn public off in one click.</p>
    <p>
      <a class="btn" href="/silent?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}">
        <button class="secondary">Go silent</button>
      </a>
    </p>

    <hr>
    <h2>Connect Claude / ChatGPT <span class="small">(optional, one-time)</span></h2>
    <p><a href="/claude?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}">Open the setup snippet</a> — paste once at the top of a fresh Claude/ChatGPT chat (any plan, including free), or into a Project/Custom GPT if you have Pro/Plus. Then update your location and check on friends without ever leaving the chat.</p>

    <hr>
    <h2>Settings</h2>
    <p>Timezone: <strong>${escapeHtml(tz)}</strong></p>
    <form action="/tz" method="get">
      <input type="hidden" name="u" value="${escapeHtml(me)}">
      <input type="hidden" name="t" value="${escapeHtml(tok)}">
      <div class="row">
        <input type="text" name="tz" placeholder="America/Los_Angeles">
        <button>Update</button>
      </div>
    </form>

    <hr>
    <h2>Delete account</h2>
    <p class="small">Permanent. Removes you from everyone's allowlist and invalidates your token.</p>
    <p>
      <a class="btn" href="/delete?u=${encodeURIComponent(me)}&t=${encodeURIComponent(tok)}&confirm=yes"
         onclick="return confirm('Permanently delete your account? This cannot be undone — your token will stop working and you will be removed from everyone\\'s allowlist.');">
        <button class="secondary">Delete account…</button>
      </a>
    </p>
  `, 200, 60);
}

// Writes use GET so chat assistants' web-fetch tools (which fire GETs reliably,
// POSTs less so) can drive the app. No CDN cache sits in front, so the usual
// GET-side-effect risks don't apply. See architecture.md → "Design choices".
async function setLocation(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  // Strip control whitespace so /me's line-based format stays parseable. Without
  // this, a pasted multiline string lands a raw \n in the response body and any
  // line-based reader (e.g. Claude via WebFetch) misparses the 5-line contract.
  const loc = (q.get('loc') || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!loc) return err('Missing loc.');
  if (loc.length > 200) return err('Location too long (200 char max).');
  let hours = parseFloat(q.get('hours') || '2');
  if (!isFinite(hours) || hours <= 0) hours = 2;
  if (hours > 24) hours = 24;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  user.location = { text: loc, expiresAt };
  await putUser(env, u, user);
  return text(`OK. Location set: ${loc} (${hours}h, until ${fmtClock(expiresAt, user.tz)}).\n`);
}

async function clearLocation(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  user.location = null;
  await putUser(env, u, user);
  return text('OK. Location cleared.\n');
}

async function showMe(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
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

async function viewUser(env, target, q) {
  if (!target) return err('Missing target user.');
  const viewer = (q.get('as') || '').toLowerCase();
  const vtoken = q.get('t');
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
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  const friend = (q.get('friend') || '').trim().toLowerCase();
  if (!friend) return err('Missing friend.');
  user.allowlist = user.allowlist || [];
  if (!user.allowlist.includes(friend)) user.allowlist.push(friend);
  await putUser(env, u, user);
  return text(`OK. ${friend} can now see your location.\n`);
}

async function disallow(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  const friend = (q.get('friend') || '').trim().toLowerCase();
  if (!friend) return err('Missing friend.');
  user.allowlist = (user.allowlist || []).filter(x => x !== friend);
  await putUser(env, u, user);
  return text(`OK. ${friend} can no longer see your location.\n`);
}

async function setPublic(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  user.public = q.get('on') === '1';
  await putUser(env, u, user);
  return text(`OK. Public mode: ${user.public ? 'ON' : 'OFF'}.\n`);
}

async function goSilent(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  user.location = null;
  user.public = false;
  await putUser(env, u, user);
  return text(`OK. Going silent: location cleared, public mode OFF.\n`);
}

async function setTz(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
  if (!user) return err('Invalid token.', 401);
  const tz = (q.get('tz') || '').trim();
  if (!tz) return err('Missing tz. Use an IANA name like America/Los_Angeles.');
  try {
    new Intl.DateTimeFormat([], { timeZone: tz });
  } catch (e) {
    return err(`Invalid timezone: ${tz}. Use an IANA name like America/Los_Angeles.`);
  }
  user.tz = tz;
  await putUser(env, u, user);
  return text(`OK. Timezone set to ${tz}.\n`);
}

// Invites carry a 7-day expiry so stale links can't be redeemed months later.
// They also snapshot the inviter's depth so signup can compute the new user's
// depth even if the inviter is deleted between invite creation and use.
async function makeInvite(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
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
    <pre>${escapeHtml(url)}</pre>
    <p class="small">Single-use. Expires ${escapeHtml(expiryDate)} (7 days from now).</p>
    <p><a href="/dashboard?u=${encodeURIComponent(u)}&t=${encodeURIComponent(q.get('t'))}">Back to dashboard</a></p>
  `);
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
  return html(`
    <h1>Join Hangout</h1>
    <p>Invited by <strong>${escapeHtml(inv.from)}</strong>.</p>
    <form action="/signup" method="get">
      <input type="hidden" name="invite" value="${escapeHtml(code)}">
      <label>Pick a username (3–20 chars, lowercase letters/digits/dashes)</label>
      <input type="text" name="u" required pattern="[a-z0-9-]{3,20}">
      <p><button>Claim it</button></p>
    </form>
  `);
}

// On signup, the new user and the inviter automatically allow each other —
// otherwise they couldn't see each other's locations until both clicked through
// the allowlist UI. Either can revoke later.
async function signup(env, q) {
  const code = q.get('invite');
  const name = (q.get('u') || '').toLowerCase().trim();
  if (!code) return err('Missing invite.');
  if (!validUsername(name)) return err('Invalid username (3–20 lowercase chars/digits/dashes, not reserved).');
  const raw = await env.STATE.get(`invite:${code}`);
  if (!raw) return err('Invalid invite code.', 404);
  const inv = JSON.parse(raw);
  if (inv.used) return err('Invite already used.', 410);
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() <= Date.now()) {
    return err('Invite has expired.', 410);
  }
  if (await getUser(env, name)) return err('Username already taken.');

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
    <p>Your username: <strong>${escapeHtml(name)}</strong></p>
    <p>Your token (this is your password — save it):</p>
    <pre>${escapeHtml(token)}</pre>
    <p>You and <strong>${escapeHtml(inv.from)}</strong> can now see each other.</p>
    <p><a class="btn" href="/dashboard?u=${encodeURIComponent(name)}&t=${encodeURIComponent(token)}"><button>Open dashboard</button></a></p>
    <hr>
    <h2>Connect Claude (web or phone)</h2>
    <p>Open a Claude Project, paste the snippet from
       <a href="/claude?u=${encodeURIComponent(name)}&t=${encodeURIComponent(token)}">this page</a>
       into the project's custom instructions. Then ask Claude "where is ${escapeHtml(inv.from)}?" or "I'm at &lt;place&gt; for 2 hours."</p>
  `);
}

async function claudeInstructions(env, q, base) {
  const u = (q.get('u') || '').toLowerCase();
  const t = q.get('t');
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
    <h2>How to install</h2>
    <ol>
      <li>Click <strong>Copy snippet</strong> below.</li>
      <li><strong>Simplest (any plan):</strong> open Claude.ai or chatgpt.com → start a fresh chat → paste the snippet as your first message → bookmark or pin that chat. From now on just return to that one chat to use Hangout.</li>
      <li><strong>If you have Claude.ai Pro or ChatGPT Plus:</strong> paste the snippet into a Project's custom instructions (Claude) or a Custom GPT's instructions (ChatGPT) instead. Every new chat inside inherits the setup; syncs cleanly to mobile. (ChatGPT: also enable Web Browsing.)</li>
    </ol>
    <p class="small"><strong>Keep this snippet private.</strong> Your token is in it — anyone who has the token can post as you. Treat it like a password.</p>
    <p class="small"><strong>Claude Code users (developers):</strong> the chat-snippet path above doesn't fit Claude Code well. Use the <code>~/.claude/commands/hangout.md</code> slash-command path instead — see for-friends.md, "Advanced — Claude Code" section.</p>
    <p>
      <button id="copy-btn" onclick="copySnippet()">Copy snippet</button>
    </p>
    <pre id="snippet">${escapeHtml(snippet)}</pre>
    <p class="small"><a href="/dashboard?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}">Back to dashboard</a></p>
    <script>
      function copySnippet() {
        var text = document.getElementById('snippet').innerText;
        var btn = document.getElementById('copy-btn');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function(){
            btn.textContent = 'Copied!';
            setTimeout(function(){ btn.textContent = 'Copy snippet'; }, 2000);
          }).catch(function(){
            btn.textContent = 'Copy failed — select and copy manually';
          });
        } else {
          // Fallback: select the <pre> so user can ⌘-C
          var range = document.createRange();
          range.selectNode(document.getElementById('snippet'));
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          btn.textContent = 'Selected — press ⌘-C to copy';
        }
      }
    </script>
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
  return text(`User created.\nUsername: ${name}\nToken: ${token}\n\nSave the token — it's your password. Open: /dashboard?u=${name}&t=${token}\n`);
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
  return text(`Token rotated for ${name}.\nNew token: ${newToken}\n\nSend them this URL: /dashboard?u=${name}&t=${newToken}\n`);
}

// Permanent. Cascades through every other user's allowlist before deleting the
// record, so dangling references don't accumulate.
async function deleteAccount(env, q) {
  const u = (q.get('u') || '').toLowerCase();
  const user = await authUser(env, u, q.get('t'));
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

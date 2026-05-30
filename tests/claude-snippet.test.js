// Tests for the /claude page snippet served to users to paste into
// Claude Chat / ChatGPT. The snippet is the contract between the worker
// and the assistant — these tests pin the parts users rely on.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { unstable_dev } from 'wrangler';

let worker;
let token;
let U;        // username (random per run, so leftover local KV doesn't break us)

const SECRET = 'test-secret';
const rand = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  worker = await unstable_dev('app.js', {
    config: 'wrangler.toml',
    vars: { BOOTSTRAP_SECRET: SECRET },
    local: true,
    persist: false,
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
  U = `c${rand()}`;
  const r = await worker.fetch(`/bootstrap?s=${SECRET}&u=${U}`);
  token = (await r.text()).match(/Token: ([a-f0-9]+)/)[1];
});

after(async () => {
  await worker.stop();
});

async function snippet() {
  const html = await (await worker.fetch(`/claude?u=${U}&nonce=${token}`)).text();
  // The snippet lives inside <pre id="snippet">…</pre>.
  const m = html.match(/<pre id="snippet"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(m, '/claude page does not contain a <pre id="snippet"> block');
  // Un-HTML-escape the content so URL tests match the literal text users paste.
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

test('snippet includes a clickable dashboard markdown link', async () => {
  const s = await snippet();
  // unstable_dev's worker.fetch uses a synthetic host, so don't pin the host —
  // just confirm the markdown-link shape with the right path and credentials.
  const re = new RegExp(
    `\\[Open dashboard\\]\\(https?://[^/)]+/dashboard\\?u=${U}&nonce=${token}\\)`,
  );
  assert.match(s, re);
});

test('snippet teaches the "open my dashboard" trigger phrases', async () => {
  const s = await snippet();
  assert.match(s, /open my dashboard/i);
  assert.match(s, /in Chrome/i);
  assert.match(s, /in the browser/i);
});

test('snippet still includes /links setup and /me status URLs', async () => {
  const s = await snippet();
  assert.match(s, new RegExp(`/links\\?u=${U}&nonce=[a-f0-9]+`));
  assert.match(s, new RegExp(`/me\\?u=${U}&nonce=[a-f0-9]+`));
});

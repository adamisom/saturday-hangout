// Regression tests for the dashboard form-submit auth bug: hidden token
// inputs once used name="t" but the `?t=` → `?nonce=` rename only updated
// the server-side reader, so every form click on the dashboard returned
// 401 "Invalid token." until the inputs were renamed too. These tests
// exercise each affected form endpoint end-to-end.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { unstable_dev } from 'wrangler';

let worker;
let token;
let friendToken;
let U;        // tester username (random, to avoid clash with leftover local KV)
let FRIEND;   // friend username (same)

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

  const mint = async (u) => {
    const r = await worker.fetch(`/bootstrap?s=${SECRET}&u=${u}`);
    const t = await r.text();
    const m = t.match(/Token: ([a-f0-9]+)/);
    assert.ok(m, `bootstrap for ${u} did not return a token: ${t}`);
    return m[1];
  };

  U = `t${rand()}`;
  FRIEND = `f${rand()}`;
  token = await mint(U);
  friendToken = await mint(FRIEND);
});

after(async () => {
  await worker.stop();
});

test('landing page login form uses name="nonce"', async () => {
  const html = await (await worker.fetch('/')).text();
  assert.doesNotMatch(html, /name="t"/, 'login form still emits name="t"');
  assert.match(html, /name="nonce"/);
});

test('dashboard HTML emits no name="t" in any form', async () => {
  const html = await (await worker.fetch(`/dashboard?u=${U}&nonce=${token}`)).text();
  assert.doesNotMatch(html, /name="t"/, 'dashboard still emits name="t" in a form');
});

test('login form submission (form action=/dashboard) authenticates', async () => {
  const res = await worker.fetch(`/dashboard?u=${U}&nonce=${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(`Hi, ${U}`));
});

test('/set form submission redirects to dashboard (303), not 401', async () => {
  const res = await worker.fetch(
    `/set?u=${U}&nonce=${token}&loc=TestPlace&hours=1&return=dashboard`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 303);
});

test('/allow form submission redirects to dashboard (303), not 401', async () => {
  const res = await worker.fetch(
    `/allow?u=${U}&nonce=${token}&friend=${FRIEND}&return=dashboard`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 303);
});

test('/save-preset form submission redirects to dashboard (303), not 401', async () => {
  const res = await worker.fetch(
    `/save-preset?u=${U}&nonce=${token}&loc=Home&return=dashboard`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 303);
});

test('/tz form submission redirects to dashboard (303), not 401', async () => {
  const res = await worker.fetch(
    `/tz?u=${U}&nonce=${token}&tz=America/Los_Angeles&return=dashboard`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 303);
});

test('regression: submitting with the old ?t= param fails 401', async () => {
  const res = await worker.fetch(`/set?u=${U}&t=${token}&loc=X&hours=1`);
  assert.equal(res.status, 401);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { BloomFilter } from '../src/bloom.js';
import { UsernameService, loadOrBuildBloom } from '../src/usernames.js';
import { createServer } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'usernames-'));
const opts = { bloomPath: join(dir, 'u.bloom'), bloomCapacity: 10_000, bloomFpRate: 0.01 };
const quiet = () => {};
let db, service, server, base;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/bloom_usernames_test');
  await db.query('TRUNCATE users');
  await db.query("INSERT INTO users (username) VALUES ('mohit'), ('rahul_sharma'), ('admin')");

  service = new UsernameService(db, await loadOrBuildBloom(db, opts, quiet));
  server = createServer(service);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.end();
});

const check = (name) => fetch(`${base}/usernames/${encodeURIComponent(name)}/availability`);
const register = (body) =>
  fetch(`${base}/usernames`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('taken username is confirmed by the database and gets free suggestions', async () => {
  const res = await check('Mohit');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.username, 'mohit');
  assert.equal(body.available, false);
  assert.equal(body.checkedVia, 'database');
  assert.equal(body.suggestions.length, 3);
  for (const s of body.suggestions) assert.equal((await (await check(s)).json()).available, true);
});

test('free username is answered by the bloom filter alone', async () => {
  const body = await (await check('brand_new_user')).json();
  assert.equal(body.available, true);
  assert.equal(body.checkedVia, 'bloom');
  assert.equal(body.suggestions, undefined);
});

test('/db endpoint skips the bloom filter and always asks Postgres', async () => {
  const taken = await (await fetch(`${base}/usernames/Mohit/availability/db`)).json();
  assert.equal(taken.username, 'mohit');
  assert.equal(taken.available, false);
  assert.equal(taken.checkedVia, 'database');
  assert.equal(taken.suggestions, undefined);

  const free = await (await fetch(`${base}/usernames/brand_new_user/availability/db`)).json();
  assert.equal(free.available, true);
  assert.equal(free.checkedVia, 'database');

  assert.equal((await fetch(`${base}/usernames/ab/availability/db`)).status, 400);
});

test('rejects invalid usernames', async () => {
  assert.equal((await check('ab')).status, 400);
  assert.equal((await check('has space')).status, 400);
  assert.equal((await fetch(`${base}/usernames/%E0%A4%A/availability`)).status, 400);
  assert.equal((await register({ username: 'x'.repeat(31) })).status, 400);
});

test('registering makes a name unavailable immediately; duplicates get 409', async () => {
  assert.equal((await register({ username: 'Fresh_Name' })).status, 201);
  assert.equal((await (await check('fresh_name')).json()).available, false);

  const dup = await register({ username: 'fresh_name' });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).suggestions.length, 3);
});

test('stats report bloom size and traffic counters', async () => {
  const stats = await (await fetch(`${base}/stats`)).json();
  assert.equal(stats.bloom.usernames, 4);
  assert.ok(stats.traffic.checks > 0);
  assert.ok(stats.traffic.answeredByBloom > 0);
  assert.equal(stats.comparison.dbOnly.requests, 2);
  assert.ok(stats.comparison.withBloom.avgMs >= 0);
});

test('stale snapshot is rebuilt from the database', async () => {
  const stale = new BloomFilter(1_000, 3);
  stale.save(opts.bloomPath);
  const rebuilt = await loadOrBuildBloom(db, opts, quiet);
  assert.equal(rebuilt.count, 4);
  assert.ok(rebuilt.mightContain('fresh_name'));
});

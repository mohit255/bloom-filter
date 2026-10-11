// Generates N unique usernames (default 10M) into Postgres, then builds the bloom snapshot.
// Usage: node scripts/seed.js [count]
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadOrBuildBloom } from '../src/usernames.js';

const target = Number(process.argv[2] ?? 10_000_000);
const BATCH_SIZE = 50_000;

const FIRST = `aarav aditya akash amit ananya anjali arjun aryan ayush deepak divya gaurav harsh ishaan
  kabir karan kavya kunal manish meera mohit neha nikhil pooja priya rahul raj rohan rohit sahil sanjay
  sneha suresh tanvi varun vikram vivek yash zara alex chris david emma james john lucas maria mike
  nina omar ravi sam sara tom anil ajay asha bhavna chetan dev esha farhan geeta hari isha jay`.split(/\s+/);
const LAST = `sharma verma gupta singh kumar patel shah mehta jain reddy nair iyer rao das bose sen ghosh
  khan malik chopra kapoor joshi pandey mishra yadav chauhan thakur saxena bhatia arora sethi bansal
  goel agarwal mittal smith jones brown wilson taylor`.split(/\s+/);
const WORDS = `king queen ace pro gamer ninja tiger lion wolf eagle shark viper striker captain champ
  boss hero legend master rider hunter blaze storm thunder shadow ghost rocket maverick sixer bowler
  batsman goal kick dunk spin yorker bouncer sniper warrior titan`.split(/\s+/);
const SEPS = ['', '.', '_'];
const RESERVED = ['admin', 'root', 'support', 'help', 'system', 'moderator', 'gamebull', 'sportsbull', 'sportsbaazi'];

// mulberry32: seeded PRNG so every run produces the same dataset.
let seed = 42;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];

function randomUsername() {
  const num = rand() < 0.95 ? String(Math.floor(rand() * 10_000)) : '';
  const shape = rand();
  if (shape < 0.5) return `${pick(FIRST)}${pick(SEPS)}${pick(LAST)}${num}`;
  if (shape < 0.8) return `${pick(WORDS)}${pick(SEPS)}${pick(FIRST)}${num}`;
  return `${pick(FIRST)}${pick(SEPS)}${pick(WORDS)}${num}`;
}

rmSync(config.bloomPath, { force: true });
mkdirSync(dirname(config.bloomPath), { recursive: true });

const db = await openDb(config.databaseUrl);
const client = await db.connect();
await client.query('TRUNCATE users');
// Bulk load: don't wait for WAL flush on every batch. Safe to lose a batch here; we'd just re-seed.
await client.query('SET synchronous_commit = off');

// ON CONFLICT DO NOTHING skips duplicates (in the table or within the batch); rowCount = rows actually inserted.
const insertBatch = async (names) =>
  (await client.query('INSERT INTO users (username) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [names])).rowCount;

const started = performance.now();
let inserted = await insertBatch(RESERVED);
let attempts = RESERVED.length;
let nextLog = 1_000_000;
const samples = [];

while (inserted < target) {
  // Never generate more than still needed, so we land on exactly `target` rows.
  const batch = Array.from({ length: Math.min(BATCH_SIZE, target - inserted) }, randomUsername);
  attempts += batch.length;
  inserted += await insertBatch(batch);
  // Every generated name is taken now (inserted by this batch or an earlier one).
  if (samples.length < 5 && rand() < 0.05) samples.push(batch[0]);
  if (inserted >= nextLog) {
    console.log(`  ${(inserted / 1e6).toFixed(0)}M inserted (${((performance.now() - started) / 1000).toFixed(1)}s)`);
    nextLog += 1_000_000;
  }
}
console.log(`inserted ${inserted.toLocaleString()} usernames (${(attempts - inserted).toLocaleString()} duplicates skipped) in ${((performance.now() - started) / 1000).toFixed(1)}s`);

await client.query('ANALYZE users');
client.release();
await loadOrBuildBloom(db, config);
await db.end();

console.log(`\ntaken usernames to try: ${[...RESERVED.slice(0, 2), ...samples].join(', ')}`);

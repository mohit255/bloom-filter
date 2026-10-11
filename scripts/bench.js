// Measures bloom vs Postgres lookup latency and the real false-positive rate on the seeded data.
// Usage: node scripts/bench.js
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadOrBuildBloom } from '../src/usernames.js';

const db = await openDb(config.databaseUrl);
const bloom = await loadOrBuildBloom(db, config);
const exists = async (username) =>
  (await db.query({ name: 'bench-exists', text: 'SELECT 1 FROM users WHERE username = $1', values: [username] })).rowCount > 0;

async function time(label, items, fn) {
  const started = process.hrtime.bigint();
  let hits = 0;
  for (const item of items) {
    let result = fn(item);
    if (result instanceof Promise) result = await result; // keep sync bloom calls free of await overhead
    if (result) hits++;
  }
  const nsPerOp = Number(process.hrtime.bigint() - started) / items.length;
  const pretty = nsPerOp >= 10_000 ? `${(nsPerOp / 1000).toFixed(1)} µs/op` : `${nsPerOp.toFixed(0)} ns/op`;
  console.log(`${label.padEnd(36)} ${pretty.padStart(12)}`);
  return hits;
}

// '-' never appears in seeded usernames, so every probe is guaranteed to be free.
const freeNames = Array.from({ length: 1_000_000 }, (_, i) => `probe-${i}`);
const { rows } = await db.query({
  text: 'SELECT username FROM users ORDER BY username OFFSET 1000000 LIMIT 200000',
  rowMode: 'array',
});
const takenNames = rows.map(([u]) => u);

console.log(`\nbloom: ${(bloom.sizeBytes / 1024 / 1024).toFixed(2)} MB, k=${bloom.hashes}, n=${bloom.count.toLocaleString()}\n`);

const falsePositives = await time('bloom.mightContain (free names)', freeNames, (u) => bloom.mightContain(u));
const bloomHits = await time('bloom.mightContain (taken names)', takenNames, (u) => bloom.mightContain(u));
// One query at a time over localhost TCP: this is the per-request cost the bloom filter saves.
await time('Postgres PK lookup (free names)', freeNames.slice(0, 20_000), exists);
await time('Postgres PK lookup (taken names)', takenNames.slice(0, 20_000), exists);

console.log(`\nfalse negatives:  ${takenNames.length - bloomHits} / ${takenNames.length.toLocaleString()} (must be 0)`);
console.log(`false positives:  ${falsePositives.toLocaleString()} / ${freeNames.length.toLocaleString()} = ${((falsePositives / freeNames.length) * 100).toFixed(3)}%`);
console.log(`theoretical FP:   ${(bloom.estimatedFpRate() * 100).toFixed(3)}%`);
await db.end();

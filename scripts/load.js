// Fixed-rate load test: sends requests on a schedule (not as fast as possible) and reports response times.
// Start the server first (npm start), then: node scripts/load.js [rate=1000] [per=min|sec] [durationSec=60]
// Traffic is 90% free names / 10% taken names, run against both endpoints one after the other.
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';

const rate = Number(process.argv[2] ?? 1000);
const per = process.argv[3] ?? 'min';
const durationSec = Number(process.argv[4] ?? 60);
const base = process.env.BASE_URL ?? `http://localhost:${config.port}`;

const perSecond = per.startsWith('s') ? rate : rate / 60;
const total = Math.round(perSecond * durationSec);
const intervalMs = 1000 / perSecond;

const db = await openDb(config.databaseUrl);
const { rows } = await db.query({ text: 'SELECT username FROM users TABLESAMPLE SYSTEM (1) LIMIT 1000', rowMode: 'array' });
await db.end();
const taken = rows.map(([u]) => u);
const nameFor = (i) => (i % 10 === 0 ? { name: taken[(i / 10) % taken.length], kind: 'taken' } : { name: `zz_free_${i}`, kind: 'free' });

const ENDPOINTS = [
  { label: '/availability     (bloom)', suffix: '', route: 'withBloom', queries: (s) => s.traffic.dbLookups },
  { label: '/availability/db  (db only)', suffix: '/db', route: 'dbOnly', queries: (s) => s.comparison.dbOnly.requests },
];

const stats = async () => (await fetch(`${base}/stats`)).json();

function percentiles(values) {
  const sorted = Float64Array.from(values).sort();
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN);
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) ?? NaN };
}

// Open loop: request i is sent at start + i·interval whether or not earlier ones have finished,
// so a slow server shows up as higher response times instead of quietly lowering the rate.
async function runAtFixedRate(suffix) {
  const latencies = { free: [], taken: [] };
  const inflight = [];
  let errors = 0;
  let sent = 0;
  const start = performance.now();

  const fire = (i) => {
    const { name, kind } = nameFor(i);
    const t0 = performance.now();
    inflight.push(
      fetch(`${base}/usernames/${name}/availability${suffix}`)
        .then(async (res) => {
          await res.arrayBuffer();
          if (!res.ok) throw new Error(String(res.status));
          latencies[kind].push(performance.now() - t0);
        })
        .catch(() => errors++),
    );
  };

  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      while (sent < total && start + sent * intervalMs <= now) fire(sent++);
      if (sent === total) return resolve();
      setTimeout(tick, Math.max(0, start + sent * intervalMs - performance.now()));
    };
    tick();
  });
  const sendSeconds = (performance.now() - start) / 1000;
  await Promise.all(inflight);
  return { latencies, errors, achieved: total / sendSeconds };
}

try {
  await stats();
} catch {
  console.error(`server not reachable at ${base}; start it first with: npm start`);
  process.exit(1);
}

// Warm Postgres' cache for the sampled taken names so neither endpoint pays for cold disk reads.
await Promise.all(taken.map((u) => fetch(`${base}/usernames/${u}/availability/db`).then((r) => r.arrayBuffer())));

const rateLabel = per.startsWith('s') ? `${rate.toLocaleString()} requests/second` : `${rate.toLocaleString()} requests/minute (${perSecond.toFixed(1)}/s)`;
console.log(`\n${rateLabel} for ${durationSec}s = ${total.toLocaleString()} requests per endpoint, 90% free / 10% taken names\n`);

const fmt = (ms) => ms.toFixed(2).padStart(7);
console.log(
  `${'endpoint'.padEnd(28)} ${'sent/s'.padStart(7)} ${'errors'.padStart(6)} ${'p50 ms'.padStart(7)} ${'p90 ms'.padStart(7)} ${'p99 ms'.padStart(7)} ${'max ms'.padStart(7)}` +
    `  ${'free p50'.padStart(8)} ${'taken p50'.padStart(9)}  ${'server ms/check'.padStart(15)} ${'Postgres queries'.padStart(16)}`,
);

for (const { label, suffix, route, queries } of ENDPOINTS) {
  const before = await stats();
  const { latencies, errors, achieved } = await runAtFixedRate(suffix);
  const after = await stats();
  const all = percentiles([...latencies.free, ...latencies.taken]);
  const serverMs = (after.comparison[route].totalMs - before.comparison[route].totalMs) / total;
  console.log(
    `${label.padEnd(28)} ${achieved.toFixed(1).padStart(7)} ${String(errors).padStart(6)} ${fmt(all.p50)} ${fmt(all.p90)} ${fmt(all.p99)} ${fmt(all.max)}` +
      `  ${fmt(percentiles(latencies.free).p50).padStart(8)} ${fmt(percentiles(latencies.taken).p50).padStart(9)}` +
      `  ${serverMs.toFixed(4).padStart(15)} ${(queries(after) - queries(before)).toLocaleString().padStart(16)}`,
  );
}

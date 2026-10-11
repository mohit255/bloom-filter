// Sends the same traffic to both availability endpoints and prints a side-by-side comparison.
// Start the server first (npm start), then: node scripts/compare.js [requests] [concurrency,...]
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';

const requests = Number(process.argv[2] ?? 20_000);
const concurrencies = (process.argv[3] ?? '1,50').split(',').map(Number);
const base = process.env.BASE_URL ?? `http://localhost:${config.port}`;

// Real taken names sampled from Postgres; free names use a prefix the seed never generates.
const db = await openDb(config.databaseUrl);
const { rows } = await db.query({ text: 'SELECT username FROM users TABLESAMPLE SYSTEM (1) LIMIT 5000', rowMode: 'array' });
await db.end();
const taken = rows.map(([u]) => u);
const free = (i) => `zz_free_${i}`;

const WORKLOADS = {
  'free names': (i) => free(i),
  'taken names': (i) => taken[i % taken.length],
  'mixed (90% free)': (i) => (i % 10 === 0 ? taken[i % taken.length] : free(i)),
};
const ENDPOINTS = {
  '/availability     (bloom)': { suffix: '', route: 'withBloom', queries: (s) => s.traffic.dbLookups },
  '/availability/db  (db only)': { suffix: '/db', route: 'dbOnly', queries: (s) => s.comparison.dbOnly.requests },
};

const stats = async () => (await fetch(`${base}/stats`)).json();

async function run(suffix, nameFor, count, concurrency) {
  const latencies = new Float64Array(count);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < count; i = next++) {
      const started = performance.now();
      const res = await fetch(`${base}/usernames/${nameFor(i)}/availability${suffix}`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await res.arrayBuffer();
      latencies[i] = performance.now() - started;
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort();
  const pct = (q) => latencies[Math.min(count - 1, Math.floor(q * count))].toFixed(2);
  return { rps: Math.round(count / seconds), p50: pct(0.5), p99: pct(0.99) };
}

try {
  await stats();
} catch {
  console.error(`server not reachable at ${base}; start it first with: npm start`);
  process.exit(1);
}

// Warm up before measuring: JIT, keep-alive sockets, prepared statements, and Postgres buffer cache.
// Without this, whichever endpoint runs first pays to read the sampled taken names' pages from disk.
process.stdout.write('warming up...');
for (const { suffix } of Object.values(ENDPOINTS)) {
  for (const nameFor of Object.values(WORKLOADS)) await run(suffix, nameFor, Math.min(requests, taken.length), 50);
}
console.log(' done');

for (const concurrency of concurrencies) {
  console.log(`\n${requests.toLocaleString()} requests per run, concurrency ${concurrency}, against ${base}\n`);
  console.log(
    `${'workload'.padEnd(18)} ${'endpoint'.padEnd(28)} ${'req/s'.padStart(7)} ${'p50 ms'.padStart(8)} ${'p99 ms'.padStart(8)}` +
      ` ${'server ms/check'.padStart(16)} ${'Postgres queries'.padStart(17)}`,
  );

  for (const [workload, nameFor] of Object.entries(WORKLOADS)) {
    for (const [label, { suffix, route, queries }] of Object.entries(ENDPOINTS)) {
      const before = await stats();
      const { rps, p50, p99 } = await run(suffix, nameFor, requests, concurrency);
      const after = await stats();
      // p50/p99 are client-side (include HTTP); server ms/check is just the availability check itself,
      // including any wait for a free connection from the 10-connection pool.
      const serverMs = (after.comparison[route].totalMs - before.comparison[route].totalMs) / requests;
      const dbQueries = queries(after) - queries(before);
      console.log(
        `${workload.padEnd(18)} ${label.padEnd(28)} ${String(rps).padStart(7)} ${p50.padStart(8)} ${p99.padStart(8)}` +
          ` ${serverMs.toFixed(4).padStart(16)} ${dbQueries.toLocaleString().padStart(17)}`,
      );
    }
  }
}

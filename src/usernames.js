import { BloomFilter } from './bloom.js';

const USERNAME_RE = /^[a-z0-9._]{3,30}$/;
const REBUILD_PAGE_SIZE = 100_000;

export function normalize(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function validate(username) {
  return USERNAME_RE.test(username) ? null : 'username must be 3-30 characters: a-z, 0-9, "." or "_"';
}

/**
 * Loads the bloom snapshot from disk, or rebuilds it from the users table when the
 * snapshot is missing or stale (e.g. the process crashed before its last save).
 * Staleness is detected by row count, which holds because users are never deleted;
 * a plain bloom filter can't remove items anyway.
 */
export async function loadOrBuildBloom(db, { bloomPath, bloomCapacity, bloomFpRate }, log = console.log) {
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM users');

  try {
    const bloom = BloomFilter.load(bloomPath);
    if (bloom.count === n) {
      log(`loaded bloom snapshot: ${n.toLocaleString()} usernames`);
      return bloom;
    }
    log(`bloom snapshot has ${bloom.count.toLocaleString()} items, table has ${n.toLocaleString()}; rebuilding`);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not load bloom snapshot (${err.message}); rebuilding`);
  }

  const started = performance.now();
  const bloom = BloomFilter.forCapacity(Math.max(bloomCapacity, Math.ceil(n * 1.2)), bloomFpRate);
  // Keyset pagination over the primary key: walks all rows without holding 10M in memory.
  let after = '';
  for (;;) {
    const { rows } = await db.query({
      text: 'SELECT username FROM users WHERE username > $1 ORDER BY username LIMIT $2',
      values: [after, REBUILD_PAGE_SIZE],
      rowMode: 'array',
    });
    if (rows.length === 0) break;
    for (const [username] of rows) bloom.add(username);
    after = rows.at(-1)[0];
  }
  bloom.save(bloomPath);
  log(`built bloom from ${n.toLocaleString()} usernames in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return bloom;
}

export class UsernameService {
  constructor(db, bloom) {
    this.db = db;
    this.bloom = bloom;
    this.dirty = false;
    this.counters = { checks: 0, answeredByBloom: 0, dbLookups: 0, falsePositives: 0 };
    this.latency = { withBloom: { requests: 0, totalMs: 0 }, dbOnly: { requests: 0, totalMs: 0 } };
  }

  /**
   * Bloom says "no"    → definitely free, answer without touching Postgres (~99% of new names).
   * Bloom says "maybe" → confirm against Postgres, since it may be a false positive.
   */
  async check(username) {
    const started = performance.now();
    this.counters.checks++;
    if (!this.bloom.mightContain(username)) {
      this.counters.answeredByBloom++;
      return this.#timed('withBloom', started, { available: true, checkedVia: 'bloom' });
    }
    this.counters.dbLookups++;
    const taken = await this.#existsInDb(username);
    if (!taken) this.counters.falsePositives++;
    return this.#timed('withBloom', started, { available: !taken, checkedVia: 'database' });
  }

  /** Baseline for comparison: skips the bloom filter and always queries Postgres. */
  async checkDirect(username) {
    const started = performance.now();
    const taken = await this.#existsInDb(username);
    return this.#timed('dbOnly', started, { available: !taken, checkedVia: 'database' });
  }

  async #existsInDb(username) {
    const { rowCount } = await this.db.query({
      name: 'username-exists',
      text: 'SELECT 1 FROM users WHERE username = $1',
      values: [username],
    });
    return rowCount > 0;
  }

  #timed(route, started, result) {
    const tookMs = performance.now() - started;
    this.latency[route].requests++;
    this.latency[route].totalMs += tookMs;
    return { ...result, tookMs: +tookMs.toFixed(3) };
  }

  /** Returns false if the username is already taken. The PRIMARY KEY is the real race guard. */
  async register(username) {
    const { rowCount } = await this.db.query({
      name: 'username-insert',
      text: 'INSERT INTO users (username) VALUES ($1) ON CONFLICT DO NOTHING',
      values: [username],
    });
    if (rowCount === 0) return false;
    this.bloom.add(username);
    this.dirty = true;
    return true;
  }

  /** Bloom negatives are guaranteed free, so suggestions cost zero DB queries. */
  suggest(username, limit = 3) {
    const base = username.slice(0, 26);
    const suggestions = [];
    for (let attempt = 0; suggestions.length < limit && attempt < 50; attempt++) {
      const n = 1 + Math.floor(Math.random() * (attempt < 10 ? 99 : 999));
      const candidate = `${base}${['', '_', '.'][attempt % 3]}${n}`;
      if (!suggestions.includes(candidate) && !this.bloom.mightContain(candidate)) suggestions.push(candidate);
    }
    return suggestions;
  }

  snapshot(path) {
    if (!this.dirty) return;
    this.bloom.save(path);
    this.dirty = false;
  }

  stats() {
    const { bits, hashes, count, sizeBytes } = this.bloom;
    const { checks, answeredByBloom, dbLookups, falsePositives } = this.counters;
    // FP rate = false positives / all checks for names that were NOT taken.
    const freeNameChecks = answeredByBloom + falsePositives;
    return {
      bloom: {
        usernames: count,
        bits,
        hashFunctions: hashes,
        sizeMB: +(sizeBytes / 1024 / 1024).toFixed(2),
        estimatedFpRate: +this.bloom.estimatedFpRate().toFixed(5),
      },
      traffic: {
        ...this.counters,
        dbLookupsAvoided: checks ? `${(((checks - dbLookups) / checks) * 100).toFixed(1)}%` : null,
        observedFpRate: freeNameChecks ? +(falsePositives / freeNameChecks).toFixed(5) : null,
      },
      // Server-side time per availability check, excluding HTTP overhead.
      comparison: Object.fromEntries(
        Object.entries(this.latency).map(([route, { requests, totalMs }]) => [
          route,
          { requests, totalMs: +totalMs.toFixed(3), avgMs: requests ? +(totalMs / requests).toFixed(4) : null },
        ]),
      ),
    };
  }
}

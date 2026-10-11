# Username availability API with a Bloom filter (10M usernames)

A Node 24 service (`node:http` + `pg`) that answers "is this username available?" against
10 million usernames stored in a local Postgres database.

## How it works

```
GET /usernames/:name/availability
        │
        ▼
  Bloom filter (13.7 MB, in memory)
        │
   "definitely not present" ──► available: true      (no DB query, ~0.4 µs)
        │
   "maybe present"
        ▼
  Postgres PRIMARY KEY lookup ──► available: true/false (confirms; ~42 µs)
```

- A Bloom filter **never gives false negatives**. When it says "no", the name is guaranteed free.
- It **does give false positives** (≈0.4% here). So a "maybe" is always confirmed in Postgres.
- Most availability checks are for names nobody has taken. Over 99% of those return without touching Postgres.
- Suggestions for a taken name are produced by checking only the Bloom filter. A "no" is a guarantee, so suggestions cost zero DB queries.

### Sizing math

| Formula | 10M @ 1% | Used here: 12M @ 1% (20% headroom) |
|---|---|---|
| bits `m = -n·ln(p) / (ln 2)²` | 95.9M bits = **11.4 MB** | 115M bits = **13.7 MB** |
| hashes `k = (m/n)·ln 2` | 7 | 7 |
| FP at 10M items `(1 - e^(-kn/m))^k` | 1.0% | **0.41%** |

For comparison, the Postgres `users` table plus its index is **941 MB** on disk.

Hashing uses MurmurHash3 twice (two seeds). The 7 bit positions come from those two hashes using
Kirsch–Mitzenmacher double hashing.

## Setup

Uses the local Postgres server and its own database, `bloom_usernames`, plus `bloom_usernames_test` for tests.

```bash
createdb bloom_usernames
createdb bloom_usernames_test
npm install

npm run seed      # 10M usernames → Postgres + data/usernames.bloom (14 MB), ~2.5 min
npm start         # http://localhost:3000
npm run bench     # in-process latency + measured false-positive rate
npm run compare   # HTTP load test: bloom endpoint vs direct-DB endpoint (server must be running)
npm test          # 12 tests (API tests run against bloom_usernames_test)
```

The `users` table is created automatically on first connect. `node scripts/seed.js 1000000` seeds a smaller dataset.

Env vars:
- `DATABASE_URL` (default `postgres://localhost:5432/bloom_usernames`)
- `TEST_DATABASE_URL`
- `PORT`, `BLOOM_PATH`, `BLOOM_CAPACITY`, `BLOOM_FP_RATE`

## Schema

```sql
CREATE TABLE users (
  username   text COLLATE "C" PRIMARY KEY,   -- byte-order compare: correct for [a-z0-9._], faster B-tree
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## API

```bash
# Check availability
curl localhost:3000/usernames/amit_batsman6142/availability
{"username":"amit_batsman6142","available":false,"checkedVia":"database",
 "suggestions":["amit_batsman614288","amit_batsman6142_5","amit_batsman6142.77"],"tookMs":1.911}

curl localhost:3000/usernames/mohit_chack/availability
{"username":"mohit_chack","available":true,"checkedVia":"bloom","tookMs":0.024}

# Same check, but skip the bloom filter and always query Postgres (baseline for comparison)
curl localhost:3000/usernames/mohit_chack/availability/db
{"username":"mohit_chack","available":true,"checkedVia":"database","tookMs":0.978}

# Register (201 created, 409 taken + suggestions, 400 invalid)
curl -XPOST localhost:3000/usernames -d '{"username":"mohit_chack"}'

# Filter size, estimated vs observed FP rate, % of DB lookups avoided,
# and avg server-side ms per check for each endpoint ("comparison")
curl localhost:3000/stats
```

Usernames are trimmed and lowercased, then must match `^[a-z0-9._]{3,30}$`.

## Code walkthrough: from adding a username to checking it

References are `file:line`. If the code changes, these line numbers will drift.

### The files

| File | What it does |
|---|---|
| `src/bloom.js` | The Bloom filter itself: hashing, the bit array, add, check, save/load. It knows nothing about usernames or Postgres. |
| `src/usernames.js` | The username logic: validation, the check flow (filter first, then Postgres), signup, suggestions, building the filter at startup. |
| `src/server.js` | HTTP routes, plus startup and shutdown. |
| `src/db.js` | The Postgres connection pool and the `users` table. |
| `src/config.js` | Settings: capacity 12M, false-positive rate 1%, file paths. |
| `scripts/seed.js` | Generates the 10M usernames. |
| `scripts/bench.js` | Measures lookup speed and the real false-positive rate. |
| `scripts/compare.js` | Load-tests the Bloom endpoint against the direct-DB endpoint. |

```
Startup: server.js:73 → loadOrBuildBloom (usernames.js:20) → load the saved file, or add all 10M names
Signup:  POST /usernames → server.js:47 → register (usernames.js:103) → INSERT → bloom.add (bloom.js:87)
Check:   GET .../availability → server.js:33 → check (usernames.js:66) → mightContain (bloom.js:97) → Postgres only on "maybe"
```

### Step 1: Startup creates the filter

`npm start` runs `src/server.js:71-75`:

```js
const db = await openDb(config.databaseUrl);      // db.js:4 – 10-connection pool, creates the table if missing
const bloom = await loadOrBuildBloom(db, config);  // usernames.js:20
const service = new UsernameService(db, bloom);    // usernames.js:54
const server = createServer(service);              // server.js:26
```

**`loadOrBuildBloom`** (`usernames.js:20-51`):
1. `:21` counts the rows in Postgres.
2. `:24-28` loads `data/usernames.bloom` from disk. If its saved count matches the row count, it uses that file, which takes about 1s.
3. Otherwise, `:35` creates an empty filter. Then `:37-47` reads every username from Postgres, 100,000 at a time, and calls `bloom.add()` on each one. That takes about 7s for 10M.

**Sizing the filter**: `BloomFilter.forCapacity` (`bloom.js:60-64`)

```js
const bits   = Math.ceil((-capacity * Math.log(fpRate)) / Math.LN2 ** 2);   // :61
const hashes = Math.max(1, Math.round((bits / capacity) * Math.LN2));       // :62
```

With capacity 12,000,000 and a 1% false-positive rate (`config.js:10-11`), this gives **115,020,701 bits** and **7 hash functions** (see [Sizing math](#sizing-math)).

**The bit array**: constructor (`bloom.js:66-73`)

```js
data = new Uint8Array(Math.ceil(bits / 8))   // :66 → 14,377,588 bytes = 13.7 MB, all zeros
this.positions = new Uint32Array(hashes)     // :72 → reusable slot for the 7 positions
```

That is the whole filter: one large array of bits, all 0 at the start. Each byte holds 8 bits, so 115M yes/no flags fit in 13.7 MB.

### Step 2: Adding a username

`bloom.add()` has two callers:
- **Startup rebuild**, at `usernames.js:45`, once for each row in Postgres.
- **A new signup**: `POST /usernames` → `server.js:47-55` → `service.register()`.

#### 2a. `register` (`usernames.js:103-113`)

```js
INSERT INTO users (username) VALUES ($1) ON CONFLICT DO NOTHING   // :106
if (rowCount === 0) return false;   // :109 name already existed → HTTP 409
this.bloom.add(username);           // :110 only after Postgres accepted it
this.dirty = true;                  // :111 the saved file is now out of date
```

Postgres goes first. If two people try to sign up for the same name at the same moment, the primary key picks the winner. The filter only mirrors what is already in the table.

#### 2b. `bloom.add` (`bloom.js:87-94`)

```js
this.#fillPositions(item);               // :88 work out the 7 bit positions
for (let i = 0; i < this.hashes; i++) {
  const p = this.positions[i];
  this.data[p >>> 3] |= 1 << (p & 7);    // :91 turn that bit on
}
this.count++;                            // :93
```

#### 2c. `#fillPositions`: name → 7 positions (`bloom.js:76-85`)

```js
const [bytes, len] = toBytes(item);         // :77 "amit_batsman6142" → 16 UTF-8 bytes
let a = murmur3(bytes, len, 0);             // :78 hash #1
let b = murmur3(bytes, len, 0x9747b28c);    // :79 hash #2 (different seed)
for (let i = 0; i < this.hashes; i++) {
  this.positions[i] = a % this.bits;        // :81 a position from 0 to 115,020,700
  a = (a + b) >>> 0;                        // :82
  b = (b + i + 1) >>> 0;                    // :83
}
```

- **`toBytes`** (`:44-49`) converts the string to bytes. It reuses one 512-byte buffer (`:42`), so no memory is allocated per call.
- **`murmur3`** (`:4-39`) is a fast hash. The same input always gives the same 32-bit number, and changing one character gives a completely different number.
- **Two hashes, not seven.** Only two hashes are computed. The other five positions are derived from them (`a`, `a+b`, `a+2b+1`, …). This known trick, called Kirsch–Mitzenmacher double hashing, gives the same accuracy as 7 separate hashes at about a third of the cost.

#### 2d. Setting the bit (`bloom.js:91`)

- `p >>> 3` is p ÷ 8, which picks the byte.
- `p & 7` is p mod 8, which picks the bit inside that byte.
- `1 << bit` builds a mask with only that bit set.
- `|=` turns that one bit on and leaves the other 7 bits in the byte alone.

**Real positions for `amit_batsman6142`** in the seeded filter:

| i | Position | Byte (`p>>>3`) | Bit (`p&7`) | Mask |
|---|---|---|---|---|
| 0 | 94,859,957 | 11,857,494 | 5 | `00100000` |
| 1 | 102,225,872 | 12,778,234 | 0 | `00000001` |
| 2 | 109,591,788 | 13,698,973 | 4 | `00010000` |
| 3 | 77,756,347 | 9,719,543 | 3 | `00001000` |
| 4 | 85,122,268 | 10,640,283 | 4 | `00010000` |
| 5 | 92,488,193 | 11,561,024 | 1 | `00000010` |
| 6 | 60,652,764 | 7,581,595 | 4 | `00010000` |

The name itself is never stored, only these 7 bits. That's why 10M names fit in 13.7 MB instead of about 1 GB. After all 10M adds, **45.6% of the 115M bits are 1**.

### Step 3: Checking a username

Example request: `GET /usernames/mohit_chack/availability`

#### 3a. The route (`server.js:33-43`)

```js
const match = ... pathname.match(AVAILABILITY_ROUTE);       // :33 (the regex is at :6)
const username = normalize(decodeURIComponent(match[1]));     // :35 "Mohit_Chack " → "mohit_chack"
const error = validate(username);                             // :36 3–30 chars of a-z, 0-9, . or _
if (match[2]) return ... service.checkDirect(username)        // :39 the /db endpoint, skips the filter
const result = await service.check(username);                 // :41
const suggestions = result.available ? undefined : service.suggest(username);  // :42
```

#### 3b. `service.check`: where the decision is made (`usernames.js:66-77`)

```js
if (!this.bloom.mightContain(username)) {              // :69
  return { available: true, checkedVia: 'bloom' };     // :71 no Postgres query at all
}
const taken = await this.#existsInDb(username);        // :74 SELECT 1 FROM users WHERE username = $1
if (!taken) this.counters.falsePositives++;            // :75 filter said "maybe", Postgres said "no"
return { available: !taken, checkedVia: 'database' };  // :76
```

#### 3c. `bloom.mightContain` (`bloom.js:97-104`)

```js
this.#fillPositions(item);                                        // :98 same 7 positions as add()
for (let i = 0; i < this.hashes; i++) {
  const p = this.positions[i];
  if ((this.data[p >>> 3] & (1 << (p & 7))) === 0) return false;  // :101 any bit is 0 → never added
}
return true;                                                      // :103 all 7 bits are 1 → maybe added
```

The same name always produces the same 7 positions as when it was added. That gives two guarantees:
- **If the name was added, all 7 bits are 1.** So a taken name is never reported as free.
- **If any bit is 0, the name was never added.** The loop stops at the first 0.

**Real positions for `mohit_chack`** (not in the database):

| i | Position | Bit set? |
|---|---|---|
| 0 | 59,022,335 | **0 → returns `false` here** |
| 1 | 84,271,660 | 1 |
| 2 | 70,319,627 | 1 |
| 3 | 56,367,596 | 0 |
| 4 | 81,616,927 | 0 |
| 5 | 67,664,903 | 1 |
| 6 | 53,712,884 | 1 |

The loop reads a single byte, stops at i=0, and the API answers "available" without querying the database.

**Where false positives come from.** 4 of `mohit_chack`'s 7 bits are already 1, set by other usernames that happen to hash to the same spots. If all 7 had been 1 by coincidence, the filter would say "maybe" and Postgres would answer "not found". That is a false positive, counted at `usernames.js:75`. With 45.6% of bits set, the chance of all 7 being 1 is **0.456⁷ ≈ 0.41%**, which matches the 0.410% measured in the benchmark.

For `amit_batsman6142`, all 7 bits are 1, so `mightContain` returns true, Postgres confirms the name exists, and the API returns `available: false`.

### Step 4: Suggestions (`usernames.js:116-125`)

For a taken name, this tries variations like `name42`, `name_17` and `name.88`. It keeps the ones where `mightContain` returns false (`:122`). A false answer means the name was never added, so every suggestion is guaranteed free, and none of them cost a Postgres query.

### Step 5: Saving the filter to disk

- **When it saves:** `snapshot()` (`usernames.js:127-131`) writes only if something changed (`dirty`). It runs every 60s (`server.js:81`) and on Ctrl+C or SIGTERM (`server.js:83-90`).
- **`save()`** (`bloom.js:115-124`) writes a 16-byte header (the marker "BLM1", the bit count, the hash count, the item count) followed by the raw 13.7 MB bit array. It writes to a `.tmp` file first and then renames it (`:121-123`), so a crash mid-write never leaves a half-written file.
- **`load()`** (`bloom.js:126-136`) checks the "BLM1" marker (`:128`) and uses the bytes in place without copying them (`:134`).

### Important parts: things that break if you change them

1. **Usernames are normalized before both add and check** (`usernames.js:6-8`). The filter compares exact bytes. If signup stored "Mohit" but a check looked up "mohit", the 7 positions would differ and a taken name would show as free. Every request path calls `normalize()` first (`server.js:35`, `:48`).
2. **The hash function and its seeds must never change** (`bloom.js:78-79`). Changing either moves every position, which makes the saved file useless. If you do change them, delete `data/usernames.bloom` to force a rebuild.
3. **Postgres before the filter on signup** (`usernames.js:104-110`). The primary key is what actually prevents duplicate usernames; the filter is only a fast cache in front of it.
4. **No deletes.** One bit is shared by many usernames (see `mohit_chack`'s bits above), so clearing a bit would break other names. Removing a user means rebuilding the filter. The startup check that compares counts (`usernames.js:25`) also assumes rows are never deleted.
5. **Capacity** (`config.js:10`). The filter is sized for 12M names. Past that, more bits become 1 and the false-positive rate rises. `estimatedFpRate` in `/stats` (`bloom.js:107-109`) shows this.
6. **32-bit math** (`Math.imul`, `>>> 0` in `bloom.js`). JavaScript numbers are 64-bit floats. Without these operations the hash produces different numbers, and positions would no longer match the saved file.
7. **The reused `positions` array** (`bloom.js:72`). It's reused on every call to avoid allocating memory. This is safe because JavaScript runs one function at a time and `add`/`mightContain` never pause partway through.

## Measured results (M-series Mac, local Postgres 18, 10M rows)

```
bloom.mightContain (free names)         413 ns/op
bloom.mightContain (taken names)        355 ns/op
Postgres PK lookup (free names)        43.8 µs/op
Postgres PK lookup (taken names)       42.0 µs/op

false negatives:  0 / 200,000
false positives:  4,096 / 1,000,000 = 0.410%   (theory: 0.409%)
```

The filter is **~100× faster** than a Postgres round trip, even over localhost.

### Bloom endpoint vs direct-DB endpoint (`npm run compare`, 20k requests per run)

Sequential requests (concurrency 1) show the true cost per request:

| Workload | Endpoint | req/s | p50 ms | Server ms/check | Postgres queries |
|---|---|---|---|---|---|
| free names | `/availability` (bloom) | **12,090** | 0.07 | **0.003** | **79** |
| free names | `/availability/db` | 7,631 | 0.12 | 0.048 | 20,000 |
| taken names | `/availability` (bloom) | 7,288 | 0.13 | 0.051 | 20,000 |
| taken names | `/availability/db` | 7,578 | 0.12 | 0.050 | 20,000 |
| mixed (90% free) | `/availability` (bloom) | **10,335** | 0.08 | **0.015** | **2,075** |
| mixed (90% free) | `/availability/db` | 7,405 | 0.13 | 0.049 | 20,000 |

- **Free names:** the filter answers alone. That's ~16× less server time, 99.6% fewer queries, and 1.6× the throughput.
- **Taken names:** both endpoints do the same single primary-key lookup, so they tie. The filter can't help when the answer is "taken".
- **At 50 concurrent:** both endpoints top out at ~23k req/s with p50 ≈ 1.8 ms, because the HTTP layer on one laptop is the bottleneck, not Postgres. The difference left is load: the bloom endpoint sent **79** queries for 20k free-name checks; the direct endpoint sent **20,000**.

Local Postgres answers in ~0.05 ms, so it never becomes the bottleneck here. Against a remote database like Aurora (~0.5–1 ms per round trip, shared connection pool, other traffic), every query the filter skips saves a network round trip and a pooled connection.

How the comparison is kept fair:
- Every workload is run through both endpoints once before measuring. Taken names are sampled from all over the table, and without this warm-up, whichever endpoint ran first paid ~3× for reading cold pages from disk.
- Results were checked with the endpoint order reversed and came out the same.

## Durability

- **Postgres is the source of truth.** The Bloom filter is a cache that can always be rebuilt.
- The filter is snapshotted to `data/usernames.bloom` every 60s (if changed) and on SIGINT/SIGTERM.
- On boot, the snapshot's item count is compared with `count(*)`. If they differ (for example after a crash), the filter is rebuilt by walking the primary key in 100k-row pages (~7s for 10M rows).
- The `PRIMARY KEY` and `INSERT … ON CONFLICT DO NOTHING` guard against races. Verified: 20 concurrent signups for one name produced 1× `201` and 19× `409`.

## Going to production

- **Multiple instances:** each instance's in-memory filter would miss signups made on other instances. Fixes:
  - Put the filter in Redis/Valkey and share it (`BF.RESERVE` / `BF.ADD` / `BF.EXISTS`). ElastiCache for Valkey 8.1+ supports Bloom filters natively.
  - Or broadcast new usernames (SNS/SQS/Kafka) so every instance adds them locally.
- **Deletes / renames:** a plain Bloom filter can't remove items. Either rebuild it periodically or use a counting Bloom filter or a cuckoo filter.
- **Growth:** the FP rate rises as items exceed capacity. Watch `estimatedFpRate` in `/stats` and rebuild with a larger `BLOOM_CAPACITY` before it passes your target.
- **Enumeration:** availability endpoints let anyone probe which accounts exist. Rate-limit per IP/device (WAF or API gateway).
- **Faster seeding:** use `COPY` (e.g. `pg-copy-streams`) into an unindexed staging table, then insert the distinct rows. That's much faster than batched `INSERT … ON CONFLICT` into a growing B-tree.

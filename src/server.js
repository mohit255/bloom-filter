import http from 'node:http';
import { config } from './config.js';
import { openDb } from './db.js';
import { UsernameService, loadOrBuildBloom, normalize, validate } from './usernames.js';

const AVAILABILITY_ROUTE = /^\/usernames\/([^/]+)\/availability(\/db)?$/;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limitBytes = 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limitBytes) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 });
  }
}

export function createServer(service) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    try {
      // GET /usernames/:username/availability      bloom filter, then Postgres only on "maybe"
      // GET /usernames/:username/availability/db   Postgres every time (baseline for comparison)
      const match = req.method === 'GET' && pathname.match(AVAILABILITY_ROUTE);
      if (match) {
        const username = normalize(decodeURIComponent(match[1]));
        const error = validate(username);
        if (error) return send(res, 400, { error });

        if (match[2]) return send(res, 200, { username, ...(await service.checkDirect(username)) });

        const result = await service.check(username);
        const suggestions = result.available ? undefined : service.suggest(username);
        return send(res, 200, { username, ...result, suggestions });
      }

      // POST /usernames  {"username": "..."}
      if (req.method === 'POST' && pathname === '/usernames') {
        const username = normalize((await readJson(req))?.username);
        const error = validate(username);
        if (error) return send(res, 400, { error });

        if (!(await service.register(username))) {
          return send(res, 409, { error: 'username already taken', suggestions: service.suggest(username) });
        }
        return send(res, 201, { username });
      }

      if (req.method === 'GET' && pathname === '/stats') return send(res, 200, service.stats());
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });

      send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err.status) return send(res, err.status, { error: err.message });
      if (err instanceof URIError) return send(res, 400, { error: 'malformed username encoding' });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });
}

if (import.meta.main) {
  const db = await openDb(config.databaseUrl);
  const bloom = await loadOrBuildBloom(db, config);
  const service = new UsernameService(db, bloom);
  const server = createServer(service);

  const { sizeMB, hashFunctions, estimatedFpRate } = service.stats().bloom;
  console.log(`bloom: ${sizeMB} MB, ${hashFunctions} hashes, est. FP rate ${(estimatedFpRate * 100).toFixed(2)}%`);

  // Persist new signups so the next boot can skip the rebuild.
  setInterval(() => service.snapshot(config.bloomPath), 60_000).unref();

  const shutdown = async () => {
    server.close();
    service.snapshot(config.bloomPath);
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, () => console.log(`listening on http://localhost:${config.port}`));
}

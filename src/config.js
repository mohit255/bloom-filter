import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/bloom_usernames',
  bloomPath: process.env.BLOOM_PATH ?? `${dataDir}usernames.bloom`,
  // 10M existing users + 20% headroom for new signups before the FP rate degrades.
  bloomCapacity: Number(process.env.BLOOM_CAPACITY ?? 12_000_000),
  bloomFpRate: Number(process.env.BLOOM_FP_RATE ?? 0.01),
};

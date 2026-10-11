import pg from 'pg';

/** The source of truth. The bloom filter is only ever a cache in front of this table. */
export async function openDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // COLLATE "C": usernames are plain lowercase ASCII, so byte-order comparison is correct
  // and noticeably faster than locale-aware collation on a 10M-row B-tree.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username   text COLLATE "C" PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  return pool;
}

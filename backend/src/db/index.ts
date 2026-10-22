import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export type Db = ReturnType<typeof drizzlePg<typeof schema>>

/**
 * Postgres when DATABASE_URL is set (Docker Compose, production); otherwise embedded Postgres (PGlite) in `dir`,
 * or in memory for tests. Same schema and migrations either way.
 */
export async function openDb(opts: { url?: string; dir?: string } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url })
    const db = drizzlePg(pool, { schema })
    await migratePg(db, { migrationsFolder })
    return { db, close: () => pool.end() }
  }
  if (opts.dir && opts.dir !== 'memory://') mkdirSync(opts.dir, { recursive: true })
  const client = new PGlite(opts.dir ?? 'memory://')
  const db = drizzlePglite(client, { schema })
  await migratePglite(db, { migrationsFolder })
  // Both drivers share drizzle's Postgres query builder; the cast lets one type serve both.
  return { db: db as unknown as Db, close: () => client.close() }
}

export { schema }

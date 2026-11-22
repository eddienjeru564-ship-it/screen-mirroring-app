// Runs the real ScreenView migration (supabase/migrations/*.sql) in PGlite,
// Postgres compiled to WebAssembly, and answers SupabaseStore's REST calls the
// way Supabase's API (PostgREST) does. This tests the actual SQL function, not
// a JavaScript imitation of it.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = readFileSync(
  new URL('../../supabase/migrations/0001_screenview_store.sql', import.meta.url), 'utf8');
export const TEST_SECRET = 'test-secret';
export const TEST_KEY = 'sb_publishable_test';

async function freshDb() {
  const db = new PGlite();
  // Supabase's API roles, so the migration's grants apply unchanged.
  await db.exec(`create role anon; create role authenticated; create role service_role;`);
  await db.exec(MIGRATION);
  await db.query(`insert into public.screenview_config (k, v) values ('secret', $1)`, [TEST_SECRET]);
  return db;
}

/** A fetch() that serves /rest/v1/rpc/screenview_exec from its own fresh database. */
export function fakeSupabase() {
  let dbPromise = null;
  let calls = 0;
  async function fetchImpl(url, init) {
    calls++;
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.apikey !== TEST_KEY) return json(401, { message: 'Invalid API key' });
    if (!url.endsWith('/rest/v1/rpc/screenview_exec')) return json(404, { message: 'not found' });
    dbPromise ??= freshDb();
    const db = await dbPromise;
    const { p_secret, p_cmd, p_now = null } = JSON.parse(init.body);
    try {
      const { rows } = await db.query(
        'select public.screenview_exec($1, $2::jsonb, $3) as r', [p_secret, JSON.stringify(p_cmd), p_now]);
      return json(200, rows[0].r);
    } catch (err) {
      return json(err.code === '28000' ? 401 : 400, { code: err.code, message: err.message });
    }
  }
  return { fetchImpl, get calls() { return calls; } };
}

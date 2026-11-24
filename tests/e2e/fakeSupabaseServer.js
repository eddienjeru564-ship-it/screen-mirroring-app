// Serves the Supabase fake (tests/unit/fakeSupabase.js: the real SQL migration
// running in PGlite) over HTTP, so the e2e suite can run ScreenView exactly as
// on Vercel with the Supabase store, without a Supabase project.
// Usage: node tests/e2e/fakeSupabaseServer.js <port>
import http from 'node:http';
import { fakeSupabase, TEST_KEY, TEST_SECRET } from '../unit/fakeSupabase.js';

const port = Number(process.argv[2] || 3111);
const fake = fakeSupabase();

// Warm PGlite (role creation + running the migration) once, so the readiness
// check only passes after the database is ready. Playwright waits for that,
// which keeps the first real request from paying the WASM cold-start cost.
const warm = fake.fetchImpl('/rest/v1/rpc/screenview_exec', {
  headers: { apikey: TEST_KEY },
  body: JSON.stringify({ p_secret: TEST_SECRET, p_cmd: ['get', '__warm__'] }),
});

http.createServer((req, res) => {
  if (req.method === 'GET') { // readiness check — only ok once PGlite is warm
    warm.then(() => res.end('ok')).catch(() => { res.statusCode = 503; res.end('warming'); });
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const r = await fake.fetchImpl(req.url, { headers: { apikey: req.headers.apikey }, body });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await r.json()));
  });
}).listen(port);

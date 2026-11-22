// Serves the Supabase fake (tests/unit/fakeSupabase.js: the real SQL migration
// running in PGlite) over HTTP, so the e2e suite can run ScreenView exactly as
// on Vercel with the Supabase store, without a Supabase project.
// Usage: node tests/e2e/fakeSupabaseServer.js <port>
import http from 'node:http';
import { fakeSupabase } from '../unit/fakeSupabase.js';

const port = Number(process.argv[2] || 3111);
const fake = fakeSupabase();

http.createServer((req, res) => {
  if (req.method === 'GET') return res.end('ok'); // readiness check
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const r = await fake.fetchImpl(req.url, { headers: { apikey: req.headers.apikey }, body });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await r.json()));
  });
}).listen(port);

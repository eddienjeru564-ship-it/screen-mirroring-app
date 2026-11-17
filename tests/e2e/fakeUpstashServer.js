// Serves the fake Upstash REST API (tests/unit/fakeUpstash.js) over real HTTP,
// so the e2e suite can run ScreenView exactly as on Vercel (Upstash store,
// log kept in Redis) without an Upstash account.
// Usage: node tests/e2e/fakeUpstashServer.js <port>
import http from 'node:http';
import { fakeUpstash } from '../unit/fakeUpstash.js';

const port = Number(process.argv[2] || 3110);
const fake = fakeUpstash({ token: 'test-token' });

http.createServer((req, res) => {
  if (req.method === 'GET') return res.end('ok'); // readiness check
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const r = await fake.fetchImpl(req.url, {
      headers: { Authorization: req.headers.authorization },
      body,
    });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await r.json()));
  });
}).listen(port);

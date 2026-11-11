import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLogger, humanDuration } from '../../server/logger.js';

test('writes jsonl events and folds them into sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sv-log-'));
  const file = join(dir, 'sub', 'sessions.jsonl');
  const log = new SessionLogger(file);
  const s = { sessionId: 's1', code: '123456', password: null, quality: 'low', startedAt: 0, endedAt: 65_000, endReason: 'host_ended' };
  await log.sessionStart(s);
  await log.viewerJoin('s1', 'v1');
  await log.viewerLeave('s1', 'v1');
  await log.sessionEnd(s);

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4);
  for (const l of lines) JSON.parse(l); // every line is valid JSON

  const [sum] = await log.readSessions();
  assert.equal(sum.code, '123456');
  assert.equal(sum.viewerJoins, 1);
  assert.equal(sum.viewerLeaves, 1);
  assert.equal(sum.endReason, 'host_ended');
  assert.equal(sum.durationHuman, '1m 5s');
});

test('humanDuration formats', () => {
  assert.equal(humanDuration(5_000), '5s');
  assert.equal(humanDuration(3_725_000), '1h 2m 5s');
});

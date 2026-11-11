// logger.js — append-only JSON-lines session audit log.
//
// One JSON object per line in logs/sessions.jsonl. We log discrete events
// (session_start, viewer_join, viewer_leave, session_end); the admin page
// reconstructs per-session rows from them. Append-only keeps it tamper-evident
// and dead simple — no database.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class SessionLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this._chain = Promise.resolve(); // serialise appends to avoid interleaving
  }

  async #ensureDir() {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }

  /** Append one event. Never throws into the caller — logging must not break a session. */
  log(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    this._chain = this._chain
      .then(() => this.#ensureDir())
      .then(() => appendFile(this.filePath, line, 'utf8'))
      .catch((err) => console.error('[logger] failed to write log line:', err.message));
    return this._chain;
  }

  sessionStart(s) {
    return this.log({
      event: 'session_start',
      sessionId: s.sessionId,
      code: s.code,
      hasPassword: !!s.password,
      quality: s.quality,
    });
  }

  viewerJoin(sessionId, viewerId) {
    return this.log({ event: 'viewer_join', sessionId, viewerId });
  }

  viewerLeave(sessionId, viewerId) {
    return this.log({ event: 'viewer_leave', sessionId, viewerId });
  }

  sessionEnd(s) {
    const durationMs = (s.endedAt ?? Date.now()) - s.startedAt;
    return this.log({
      event: 'session_end',
      sessionId: s.sessionId,
      code: s.code,
      endReason: s.endReason,
      durationMs,
      durationHuman: humanDuration(durationMs),
    });
  }

  /** Read the raw log and fold it into per-session summaries, newest first. */
  async readSessions() {
    await this.#ensureDir();
    let text = '';
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    /** @type {Map<string, object>} */
    const sessions = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // skip corrupt lines rather than crash the admin page
      }
      const id = rec.sessionId;
      if (!id) continue;
      if (!sessions.has(id)) {
        sessions.set(id, {
          sessionId: id,
          code: rec.code ?? null,
          startTs: null,
          endTs: null,
          durationHuman: null,
          endReason: null,
          hasPassword: false,
          quality: null,
          viewerJoins: 0,
          viewerLeaves: 0,
          events: [],
        });
      }
      const sum = sessions.get(id);
      sum.events.push({ ts: rec.ts, event: rec.event, viewerId: rec.viewerId });
      if (rec.code) sum.code = rec.code;
      switch (rec.event) {
        case 'session_start':
          sum.startTs = rec.ts;
          sum.hasPassword = !!rec.hasPassword;
          sum.quality = rec.quality ?? null;
          break;
        case 'viewer_join':
          sum.viewerJoins++;
          break;
        case 'viewer_leave':
          sum.viewerLeaves++;
          break;
        case 'session_end':
          sum.endTs = rec.ts;
          sum.endReason = rec.endReason ?? null;
          sum.durationHuman = rec.durationHuman ?? null;
          break;
      }
    }
    return [...sessions.values()].sort((a, b) =>
      String(b.startTs).localeCompare(String(a.startTs))
    );
  }
}

export function humanDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

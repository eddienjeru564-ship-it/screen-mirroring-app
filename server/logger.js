// logger.js — append-only session audit log.
//
// We log discrete events (session_start, viewer_join, viewer_leave,
// session_end); the admin page folds them into per-session rows. Where the
// events are kept depends on where ScreenView runs:
//   FileSink   — logs/sessions.jsonl, one JSON object per line (laptop/LAN).
//   StoreSink  — a capped list in the session store (Vercel has no writable disk).

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** JSON-lines file. Appends are serialised so lines never interleave. */
export class FileSink {
  constructor(filePath) {
    this.filePath = filePath;
    this._chain = Promise.resolve();
  }

  append(record) {
    const line = JSON.stringify(record) + '\n';
    this._chain = this._chain
      .then(() => mkdir(dirname(this.filePath), { recursive: true }))
      .then(() => appendFile(this.filePath, line, 'utf8'));
    return this._chain;
  }

  async readAll() {
    let text = '';
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than break the admin page
      }
    }
    return out;
  }
}

/** Capped list in the store (keeps the newest `max` events). */
export class StoreSink {
  constructor(store, { key = 'sv:log', max = 5000 } = {}) {
    this.store = store;
    this.key = key;
    this.max = max;
  }

  append(record) {
    return this.store.rpush(this.key, JSON.stringify(record), { max: this.max });
  }

  async readAll() {
    const out = [];
    for (const s of await this.store.lrange(this.key)) {
      try {
        out.push(JSON.parse(s));
      } catch {
        // skip
      }
    }
    return out;
  }
}

export class SessionLogger {
  /** @param {string | {append: Function, readAll: Function}} sink file path or sink */
  constructor(sink) {
    this.sink = typeof sink === 'string' ? new FileSink(sink) : sink;
  }

  /** Append one event. Never throws — logging must not break a session. */
  async log(event) {
    try {
      await this.sink.append({ ts: new Date().toISOString(), ...event });
    } catch (err) {
      console.error('[logger] failed to write log event:', err.message);
    }
  }

  sessionStart(s) {
    return this.log({
      event: 'session_start',
      sessionId: s.sessionId,
      code: s.code,
      hasPassword: !!s.hasPassword,
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

  /** Fold the raw events into per-session summaries, newest first. */
  async readSessions() {
    /** @type {Map<string, object>} */
    const sessions = new Map();
    for (const rec of await this.sink.readAll()) {
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

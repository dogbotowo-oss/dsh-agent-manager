/**
 * Session-log surgery for `dsh-agent-manager`.
 *
 * A DSH session log is a zstd-framed JSONL file. Two invariants make deletion
 * unsafe:
 *   1. event `seq` must stay contiguous from 0 — dropping a line leaves a hole;
 *   2. `compaction/summary` events reference earlier `seq` ranges — renumbering
 *      shifts every reference.
 *
 * So this module never deletes or renumbers a record. It *retires* one in place:
 * the record keeps its `seq` and `time` but is rewritten as an unknown event
 * type carrying `ignorable: true`, which the v4 loader preserves verbatim
 * (see `dsh-session-format-v3-to-v4`: unknown type + `ignorable` is kept).
 * Projections only fold their own event type, so the retired record disappears
 * from the catalog/roster while the log stays byte-consistent.
 *
 * @module dsh-agent-manager/session-log
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE_RE = /^session(\.[^./]+)?\.jsonl(\.zstd)?$/;

/** List the candidate log files of one session directory, newest generation first. */
export function sessionLogFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => SESSION_FILE_RE.test(n))
    .map((n) => {
      const m = n.match(/^session\.v(\d+)\.jsonl/);
      return { path: path.join(dir, n), generation: m === null ? 0 : Number(m[1]) };
    })
    .sort((a, b) => b.generation - a.generation);
}

/** Offsets of every zstd frame header in a concatenated frame stream. */
function frameOffsets(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i);
    }
  }
  return offsets;
}

/**
 * Decode a whole framed log.
 * @returns {{ text: string, undecodable: number }}
 */
export function decodeSessionLog(buf) {
  const offsets = frameOffsets(buf);
  const parts = [];
  let undecodable = 0;
  let cursor = 0;
  while (cursor < offsets.length) {
    let decoded = null;
    let consumed = cursor;
    // A magic sequence may also appear inside compressed bytes; accept the
    // shortest window that decodes cleanly and continue from there.
    for (let end = cursor + 1; end <= offsets.length; end++) {
      const start = offsets[cursor];
      const stop = end < offsets.length ? offsets[end] : buf.length;
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(start, stop)).toString('utf8');
        consumed = end;
        break;
      } catch {
        /* try a longer window */
      }
    }
    if (decoded === null) {
      undecodable++;
      break;
    }
    parts.push(decoded);
    cursor = consumed;
  }
  return { text: parts.join(''), undecodable };
}

/** Encode JSONL text back into concatenated zstd frames (~1 MiB each). */
export function encodeSessionLog(text) {
  const chunks = [];
  const CHUNK = 1 << 20;
  let buffer = '';
  for (const line of text.split('\n')) {
    buffer += line + '\n';
    if (buffer.length >= CHUNK) {
      chunks.push(zlib.zstdCompressSync(Buffer.from(buffer, 'utf8')));
      buffer = '';
    }
  }
  if (buffer.length > 0) chunks.push(zlib.zstdCompressSync(Buffer.from(buffer, 'utf8')));
  return Buffer.concat(chunks);
}

/** Parse a decoded log into `{ header, headerLine, events: [{line, event}] }`. */
export function parseSessionLog(text, { strict = false } = {}) {
  const lines = text.split('\n');
  const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? 1 : 0;
  if (trailing === 1) lines.pop();
  const headerLine = lines.shift() ?? '';
  let header;
  try {
    header = JSON.parse(headerLine);
  } catch {
    throw new Error('session log header is not JSON — refusing to rewrite');
  }
  const events = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (strict) throw new Error('session log contains an unparsable record — refusing to rewrite');
      continue;
    }
    events.push({ line, event });
  }
  return { header, headerLine, events };
}

/** Serialize parsed parts back to JSONL text (records untouched). */
export function serializeSessionLog(parsed) {
  const lines = [parsed.headerLine, ...parsed.events.map((e) => e.line)];
  return lines.join('\n') + '\n';
}

/**
 * Build the retired replacement for one record while keeping its coordinates.
 * @param {object} event - decoded record
 * @param {string} retireType - namespace for the tombstone
 * @param {object} details - extra fields merged into `data`
 */
export function retireEvent(event, retireType, details) {
  return {
    type: retireType,
    seq: event.seq,
    time: event.time,
    ignorable: true,
    data: {
      retiredBy: 'dsh-agent-manager',
      retiredAt: Date.now(),
      originalType: event.type,
      ...details,
    },
  };
}

/**
 * Retire every record selected by `select` from one decoded log.
 * @param {string} text - decoded JSONL
 * @param {(event: object) => object | null} select - returns `details` to retire, or null to keep
 * @param {string} retireType
 * @returns {{ text: string, retired: number, unchanged: number }}
 */
export function retireRecords(text, select, retireType = 'agent-manager/retired') {
  const parsed = parseSessionLog(text, { strict: true });
  let retired = 0;
  let unchanged = 0;
  for (const entry of parsed.events) {
    const details = select(entry.event);
    if (details === null || details === undefined) {
      unchanged++;
      continue;
    }
    const replacement = retireEvent(entry.event, retireType, details);
    entry.line = JSON.stringify(replacement);
    entry.event = replacement;
    retired++;
  }
  return { text: retired === 0 ? text : serializeSessionLog(parsed), retired, unchanged };
}

/** Both sides of a rewrite, kept together so the caller can restore on failure. */
export function rewriteFileAtomic(file, nextBuf, { expect } = {}) {
  const before = fs.statSync(file);
  if (expect !== undefined && (before.size !== expect.size || before.mtimeMs !== expect.mtimeMs)) {
    return { ok: false, reason: 'changed-before-write' };
  }
  const temp = `${file}.agent-manager-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, nextBuf);
  const after = fs.statSync(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    fs.rmSync(temp, { force: true });
    return { ok: false, reason: 'changed-during-write' };
  }
  fs.renameSync(temp, file);
  return { ok: true };
}

/** Cheap stat fingerprint used for optimistic concurrency. */
export function fingerprint(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/** Locate one session directory under `sessionsRoot`, by name first then by header id. */
export function findSessionDir(sessionsRoot, sessionId) {
  let projects;
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  const candidates = [];
  for (const project of projects) {
    const projectDir = path.join(sessionsRoot, project.name);
    let entries;
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(projectDir, entry.name);
      if (entry.name === sessionId || entry.name === `session-${sessionId}` || `session-${entry.name}` === sessionId) {
        candidates.push({ dir, project: project.name });
        continue;
      }
      if (candidates.length > 0) continue;
      const files = sessionLogFiles(dir);
      if (files.length === 0) continue;
      try {
        const head = readHeader(files[0].path);
        if (head?.id === sessionId || head?.id === `session-${sessionId}` || `session-${head?.id}` === sessionId) {
          candidates.push({ dir, project: project.name });
        }
      } catch {
        /* not a readable session dir */
      }
    }
  }
  return candidates[0] ?? null;
}

/** Read only the header line of a (possibly compressed) session log. */
export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (file.endsWith('.zstd')) {
      const offsets = frameOffsets(buf);
      if (offsets.length === 0) return null;
      const stop = offsets.length > 1 ? offsets[1] : buf.length;
      return JSON.parse(zlib.zstdDecompressSync(buf.subarray(0, stop)).toString('utf8').split('\n')[0]);
    }
    return JSON.parse(buf.toString('utf8').split('\n')[0]);
  } finally {
    fs.closeSync(fd);
  }
}

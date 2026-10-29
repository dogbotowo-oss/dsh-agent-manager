#!/usr/bin/env node
/**
 * Self-test for the storage surgery, run against a throwaway DSH_HOME.
 * Verifies the three properties that make live log rewriting safe:
 *   1. every record keeps its `seq` (the log stays contiguous for the running host);
 *   2. only the selected records become tombstones, others stay byte-identical;
 *   3. the log still decodes frame by frame and the header is untouched.
 *
 * Usage: node lib/selftest.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-selftest-'));
process.env.DSH_HOME = home;

const { decodeSessionLog, encodeSessionLog, findSessionDir, parseSessionLog } = await import('./session-log.js');
const { retireInSession, trashSessionDir } = await import('./index.js');

const PARENT = 'session-1111';
const CHILD_KEEP = 'child-aaaa';
const CHILD_GO = 'child-bbbb';
const TEAMMATE = 'teammate-cccc';

const sessionDir = path.join(home, 'sessions', '--C-proj--', PARENT);
fs.mkdirSync(sessionDir, { recursive: true });

const header = {
  type: 'session',
  version: 4,
  id: PARENT,
  createdAt: '2026-10-29T00:00:00.000Z',
  cwd: 'C:\\proj',
};
const events = [
  { type: 'user/message', data: { text: 'hi' } },
  { type: 'subagent/catalog', data: { version: 1, childId: CHILD_KEEP, mode: 'continuable', label: 'keep me' } },
  { type: 'assistant/message', data: { text: 'delegating' } },
  { type: 'subagent/catalog', data: { version: 1, childId: CHILD_GO, mode: 'continuable', label: 'remove me' } },
  { type: 'team/member', data: { version: 2, teamId: PARENT, member: { id: TEAMMATE, name: 'dft-runner', phase: 'provisioning' } } },
  { type: 'team/member', data: { version: 2, teamId: PARENT, member: { id: TEAMMATE, name: 'dft-runner', phase: 'active' } } },
  { type: 'team/task', data: { taskId: 't1', owner: TEAMMATE, title: 'run dft' } },
  { type: 'compaction/summary', data: { fromSeq: 0, toSeq: 5, text: 'compressed' } },
].map((event, seq) => ({ ...event, seq, time: 1761700000000 + seq }));

const body = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n';
const logFile = path.join(sessionDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(logFile, encodeSessionLog(body));

const before = fs.readFileSync(logFile);
const decodedBefore = decodeSessionLog(before);
assert.equal(decodedBefore.undecodable, 0, 'fixture must decode cleanly');
const seqsBefore = parseSessionLog(decodedBefore.text).events.map((entry) => entry.event.seq).join(',');

// 1. directory discovery works for a directory name that carries the id verbatim.
assert.equal(findSessionDir(path.join(home, 'sessions'), PARENT).dir, sessionDir);

// 2. retire one subagent and one teammate.
const childResult = retireInSession(PARENT, { id: CHILD_GO, kind: 'subagent' });
assert.equal(childResult.ok, true, childResult.details.join('; '));
const teamResult = retireInSession(PARENT, { id: TEAMMATE, name: 'dft-runner', kind: 'teammate' });
assert.equal(teamResult.ok, true, teamResult.details.join('; '));

// 3. seqs are identical, tombstones are ignorable, unrelated records are untouched.
const decodedAfter = decodeSessionLog(fs.readFileSync(logFile));
assert.equal(decodedAfter.undecodable, 0, 'rewritten log must decode');
const parsed = parseSessionLog(decodedAfter.text);
assert.deepEqual(parsed.header, header, 'header must be byte-identical');
assert.equal(parsed.events.map((entry) => entry.event.seq).join(','), seqsBefore, 'seq set must not change');

const byType = (type) => parsed.events.filter((entry) => entry.event.type === type);
assert.equal(byType('agent-manager/retired').length, 3, 'one catalog + two roster records retired');
for (const entry of byType('agent-manager/retired')) {
  assert.equal(entry.event.ignorable, true, 'tombstones must be marked ignorable');
  assert.ok(entry.event.time > 0, 'tombstones keep their original timestamp');
}

const remainingCatalog = byType('subagent/catalog').map((entry) => entry.event.data.childId);
assert.deepEqual(remainingCatalog, [CHILD_KEEP], 'the other subagent stays in the catalog');
assert.equal(byType('team/member').length, 0, 'roster records are gone');
assert.equal(byType('team/task').length, 1, 'task board history is preserved');
assert.equal(byType('compaction/summary').length, 1, 'compaction references are preserved');
assert.equal(byType('user/message').length, 1);

// 4. the child's directory moves to the trash, the parent's stays.
const childDir = path.join(home, 'sessions', '--C-proj--', CHILD_GO);
fs.mkdirSync(childDir, { recursive: true });
fs.writeFileSync(path.join(childDir, 'session.v4.jsonl.zstd'), encodeSessionLog(JSON.stringify({ ...header, id: CHILD_GO }) + '\n'));
const moved = trashSessionDir(CHILD_GO);
assert.ok(moved.includes('trash'), moved);
assert.equal(fs.existsSync(childDir), false, 'child directory must be gone from sessions/');
assert.ok(fs.existsSync(sessionDir), 'parent directory must survive');

// 5. a second run is a no-op (idempotent).
const again = retireInSession(PARENT, { id: CHILD_GO, kind: 'subagent' });
assert.ok(again.details.some((line) => line.includes('already clean')), again.details.join('; '));

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write('selftest: all assertions passed\n');

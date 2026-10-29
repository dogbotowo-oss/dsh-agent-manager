#!/usr/bin/env node
/**
 * Self-test for the tool layer: mounts the plugin on a fake cordis context and
 * runs agent_list / agent_stop / agent_remove against a throwaway DSH_HOME.
 *
 * Usage: node lib/selftest-tools.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-tools-'));
process.env.DSH_HOME = home;

const { encodeSessionLog } = await import('./session-log.js');
const { apply } = await import('./index.js');

const PARENT = 'session-parent';
const TEAMMATE = 'member-1111';
const SUBAGENT = 'child-2222';

const projectDir = path.join(home, 'sessions', '--C-proj--');
const parentDir = path.join(projectDir, PARENT);
fs.mkdirSync(parentDir, { recursive: true });
const header = { type: 'session', version: 4, id: PARENT, createdAt: '2026-10-29T00:00:00.000Z', cwd: 'C:\\proj' };
const events = [
  { type: 'subagent/catalog', data: { version: 1, childId: SUBAGENT, mode: 'continuable', label: 'fix scripts' } },
  { type: 'subagent/catalog', data: { version: 1, childId: TEAMMATE, mode: 'continuable', label: 'dft-runner' } },
  { type: 'team/member', data: { version: 2, teamId: PARENT, member: { id: TEAMMATE, name: 'dft-runner', phase: 'provisioning' } } },
  { type: 'team/member', data: { version: 2, teamId: PARENT, member: { id: TEAMMATE, name: 'dft-runner', phase: 'active' } } },
].map((event, seq) => ({ ...event, seq, time: 1761700000000 + seq }));
fs.writeFileSync(
  path.join(parentDir, 'session.v4.jsonl.zstd'),
  encodeSessionLog([JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n'),
);
const childDir = path.join(projectDir, SUBAGENT);
fs.mkdirSync(childDir, { recursive: true });
fs.writeFileSync(path.join(childDir, 'session.v4.jsonl.zstd'), encodeSessionLog(JSON.stringify({ ...header, id: SUBAGENT }) + '\n'));

const calls = [];
const children = [
  { kind: 'child', id: SUBAGENT, mode: 'continuable', parentId: PARENT, depth: 1, activity: 'inactive', label: 'fix scripts' },
  { kind: 'child', id: TEAMMATE, mode: 'continuable', parentId: PARENT, depth: 1, activity: 'running', label: 'dft-runner' },
];
const members = [{ id: TEAMMATE, name: 'dft-runner', description: 'DFT runner', status: 'active' }];

const registered = [];
const teams = {
  async listMembers(caller) {
    assert.equal(caller.id, PARENT);
    return members;
  },
  async interrupt(caller, name) {
    calls.push(`team.interrupt(${name})`);
    return { previousStatus: 'active' };
  },
};
const ctx = {
  tools: { register(tool) { registered.push(tool); } },
  get(name) { return name === 'agentTeams' ? teams : undefined; },
  subagents: {
    async listDescendants(id) { assert.equal(id, PARENT); return children; },
    async interrupt(id, authority) { calls.push(`subagents.interrupt(${id}, ${authority.kind})`); },
    async drainChildren(parent, ids) { calls.push(`drainChildren(${ids.join(',')})`); },
  },
};
apply(ctx);
assert.deepEqual(registered.map((tool) => tool.name), ['agent_list', 'agent_stop', 'agent_remove']);

const caller = { id: PARENT };
const exec = { agent: caller };

const list = await registered[0].execute({}, exec);
assert.ok(list.text.includes(SUBAGENT) && list.text.includes('dft-runner'), list.text);
assert.ok(list.text.includes('caller session: session-parent'), list.text);
assert.deepEqual(registered[0].output.render({}, list)[0].type, 'text');

const stop = await registered[1].execute({ target: 'dft-runner' }, exec);
assert.ok(stop.text.includes('stopped teammate dft-runner'), stop.text);
assert.ok(calls.includes('team.interrupt(dft-runner)'), calls.join(','));
assert.ok(calls.some((call) => call === `drainChildren(${TEAMMATE})`), calls.join(','));

const dry = await registered[2].execute({ target: 'dft-runner', dry_run: true }, exec);
assert.ok(dry.text.includes('dry run'), dry.text);
assert.ok(fs.existsSync(childDir), 'dry run must not move anything');

const removed = await registered[2].execute({ target: 'fix scripts' }, exec);
assert.ok(removed.text.includes('removed subagent'), removed.text);
assert.equal(fs.existsSync(childDir), false, 'subagent session directory moved to trash');

const after = await registered[0].execute({}, exec);
assert.ok(after.text.includes('dft-runner'), 'teammate still in the fake roster (we only removed the subagent)');

const untouched = await registered[2].execute({ target: 'nobody' }, exec);
assert.ok(untouched.text.includes('failed'), untouched.text);

const parentLog = fs.readFileSync(path.join(parentDir, 'session.v4.jsonl.zstd'));
const { decodeSessionLog, parseSessionLog } = await import('./session-log.js');
const parsed = parseSessionLog(decodeSessionLog(parentLog).text);
assert.equal(parsed.events.filter((entry) => entry.event.type === 'agent-manager/retired').length, 1);
assert.equal(parsed.events.filter((entry) => entry.event.type === 'team/member').length, 2, 'roster untouched');

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write('selftest-tools: all assertions passed\n');

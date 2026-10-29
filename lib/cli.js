#!/usr/bin/env node
/**
 * Offline companion CLI for dsh-agent-manager.
 *
 * The model tools work while the host is running; this CLI exists for the case
 * the tools cannot handle — a session that the host keeps writing to. Run it
 * with DSH closed (or at least with the session not open) and it performs the
 * same two storage steps the tool performs: retire the catalog/roster records
 * and move the child session directory to the trash.
 *
 * Usage:
 *   node lib/cli.js sessions
 *   node lib/cli.js list     --session <sessionId>
 *   node lib/cli.js remove   --session <sessionId> --target <idOrName> [--keep-files] [--dry-run]
 *
 * `--session` accepts the raw session id or the on-disk directory name.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decodeSessionLog, findSessionDir, parseSessionLog, sessionLogFiles } from './session-log.js';
import { emptyTrash, purgeSessionDir, retireInSession, trashEntries, trashSessionDir } from './index.js';
import { dshHome, stateDir } from './paths.js';

function usage() {
  return [
    'dsh-agent-manager — offline subagent/teammate cleanup',
    '',
    '  sessions                                   list stored sessions that contain agents',
    '  list     --session <id>                    show the subagent catalog and team roster',
    '  remove   --session <id> --target <id|name> retire the records and dispose of the child session',
    '           [--keep-files | --purge] [--dry-run]',
    '  trash    [--empty]                         list the recycle bin, or delete everything in it',
    '',
    '--purge deletes the child session directory instead of moving it to the trash:',
    'no undo. Run it with the DSH host closed: the tool refuses logs that change mid-write.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--keep-files') options.keepFiles = true;
    else if (token === '--purge') options.purge = true;
    else if (token === '--empty') options.empty = true;
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--session') options.session = rest[++i];
    else if (token === '--target') options.target = rest[++i];
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

function sessionDirs() {
  const root = path.join(dshHome(), 'sessions');
  const dirs = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return dirs;
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectDir, entry.name);
      if (sessionLogFiles(dir).length > 0) dirs.push({ dir, project: project.name });
    }
  }
  return dirs;
}

/** Every record that names a subagent or a team member, with its line index. */
function agentRecords(dir) {
  const files = sessionLogFiles(dir);
  if (files.length === 0) return { file: null, records: [] };
  const file = files[0].path;
  const parsed = parseSessionLog(decodeSessionLog(fs.readFileSync(file)).text);
  const records = [];
  for (const entry of parsed.events) {
    const event = entry.event;
    const data = event?.data;
    if (data === null || typeof data !== 'object') continue;
    if (event.type === 'subagent/catalog' && typeof data.childId === 'string') {
      records.push({ kind: 'subagent', id: data.childId, label: data.label, mode: data.mode, seq: event.seq });
    } else if (event.type === 'subagent/catalog' && Array.isArray(data.entries)) {
      for (const item of data.entries) {
        records.push({ kind: 'subagent', id: item?.childId ?? item?.id, label: item?.label, mode: item?.mode, seq: event.seq });
      }
    } else if (event.type === 'team/member' && data.member !== null && typeof data.member === 'object') {
      records.push({
        kind: 'teammate',
        id: data.member.id,
        label: data.member.name,
        mode: data.member.phase,
        seq: event.seq,
      });
    }
  }
  return { file, records };
}

function commandSessions() {
  const rows = [];
  for (const { dir, project } of sessionDirs()) {
    const { records } = agentRecords(dir);
    if (records.length === 0) continue;
    rows.push({ session: path.basename(dir), project, agents: records.length });
  }
  if (rows.length === 0) return 'no session stores subagent or team records';
  return rows.map((row) => `${row.session}  |  ${row.project}  |  ${row.agents} record(s)`).join('\n');
}

function commandList(options) {
  if (options.session === undefined) throw new Error('--session is required');
  const found = findSessionDir(path.join(dshHome(), 'sessions'), options.session);
  if (found === null) throw new Error(`session not found: ${options.session}`);
  const { file, records } = agentRecords(found.dir);
  if (file === null) return `${found.dir}: no session log`;
  if (records.length === 0) return `${path.basename(file)}: no subagent or team records`;
  const lines = [`${path.basename(file)} (${found.project}/${path.basename(found.dir)})`];
  for (const record of records) {
    lines.push(`  ${record.kind.padEnd(9)} ${String(record.id).padEnd(40)} seq ${String(record.seq).padEnd(6)} ${record.mode ?? ''} ${String(record.label ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  return lines.join('\n');
}

function commandRemove(options) {
  if (options.session === undefined) throw new Error('--session is required');
  if (options.target === undefined) throw new Error('--target is required');
  if (options.purge === true && options.keepFiles === true) throw new Error('--purge and --keep-files are mutually exclusive');
  const found = findSessionDir(path.join(dshHome(), 'sessions'), options.session);
  if (found === null) throw new Error(`session not found: ${options.session}`);
  const { records } = agentRecords(found.dir);
  const target = records.find((record) => record.id === options.target || record.label === options.target);
  if (target === undefined) throw new Error(`no subagent or teammate "${options.target}" in that session`);
  const dispose = options.purge === true ? 'purge (delete, no trash)' : options.keepFiles === true ? 'keep files' : 'move to trash';
  const plan = [
    `session: ${path.basename(found.dir)}`,
    `target:  ${target.kind} ${target.label ?? ''} ${target.id}`,
    `dispose: ${dispose}`,
  ];
  if (options.dryRun === true) return ['dry run — nothing changed', ...plan].join('\n');
  const retired = retireInSession(path.basename(found.dir), { id: target.id, name: target.label, kind: target.kind });
  let files;
  if (options.purge === true) files = purgeSessionDir(target.id);
  else if (options.keepFiles === true) files = 'kept session directory (--keep-files)';
  else files = trashSessionDir(target.id);
  return [...plan, '', 'log:', ...retired.details.map((line) => `  ${line}`), `files: ${files}`].join('\n');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function commandTrash(options) {
  const root = path.join(stateDir(), 'trash');
  if (options.empty === true) {
    const emptied = emptyTrash();
    return `emptied ${emptied.removed} entr(ies), freed ${formatBytes(emptied.bytes)}\n${root}`;
  }
  const entries = trashEntries();
  if (entries.length === 0) return `trash is empty\n${root}`;
  const lines = [`${entries.length} entr(ies) in ${root}`];
  for (const entry of entries) lines.push(`  ${entry.at}  ${entry.name}  ${formatBytes(entry.bytes)}`);
  lines.push('', 'run `trash --empty` to delete them for good');
  return lines.join('\n');
}

function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.command === undefined || options.command === 'help' || options.command === '--help') return usage();
    if (options.command === 'sessions') return commandSessions();
    if (options.command === 'list') return commandList(options);
    if (options.command === 'remove') return commandRemove(options);
    if (options.command === 'trash') return commandTrash(options);
    return `unknown command: ${options.command}\n\n${usage()}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

process.stdout.write(`${main(process.argv.slice(2))}\n`);

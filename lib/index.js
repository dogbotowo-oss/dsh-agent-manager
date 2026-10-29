/**
 * dsh-agent-manager — host plugin that lets the model (or you) stop and really
 * remove subagents and Agent Teams teammates.
 *
 * The host exposes no delete operation on either domain:
 *   - `ctx.subagents` can interrupt and `drainChildren` (release resident
 *     instances) but never forgets a child: the parent session's own
 *     `subagent/catalog` events are the directory;
 *   - `ctx.agentTeams` keeps a flat immutable roster: `team/member` events in
 *     the Lead session are the roster, names are reserved forever.
 *
 * So removal has two halves:
 *   1. runtime — interrupt + release the resident instance (immediate, safe);
 *   2. storage — retire the catalog/roster records in the parent session log and
 *      move the child's session directory to the plugin's trash.
 *
 * Part 2 rewrites a live append-only log, which is only safe because a retired
 * record keeps its `seq` and `time` (see `session-log.js`): the log stays
 * contiguous, so a running host keeps appending correctly.
 *
 * @module dsh-agent-manager
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome, stateDir, timestamp } from './paths.js';
import {
  decodeSessionLog,
  encodeSessionLog,
  findSessionDir,
  fingerprint,
  parseSessionLog,
  retireRecords,
  rewriteFileAtomic,
  sessionLogFiles,
} from './session-log.js';

/** Cordis plugin name (also the loader entry id). */
export const name = 'agent-manager';

/** Services this plugin needs before it mounts. */
export const inject = ['tools', 'subagents'];

const RETIRE_TYPE = 'agent-manager/retired';

/**
 * Version of the *running* copy of the plugin, read from the installed
 * package.json. The panel shows it, which makes "did the app really reload the
 * new build?" answerable at a glance.
 */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/* ------------------------------------------------------- tool definitions */

/** The host renders `output.render`; every tool here answers with one text block. */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [
    { type: 'text', text: typeof value?.text === 'string' ? value.text : String(value) },
  ],
};

/** JSON Schema for a tool's `parameters` (the registry takes the schema verbatim). */
function parameters(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const TARGET_SCHEMA = {
  type: 'string',
  description: 'Target agent: a teammate name (e.g. "dft-runner") or a subagent/teammate session id.',
};

/* ------------------------------------------------------------- lookups */

function teamService(ctx) {
  try {
    return ctx.get('agentTeams');
  } catch {
    return undefined;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Children of this conversation, as projected from the parent's own catalog events. */
async function listSubagents(ctx, caller, signal) {
  try {
    const rows = await ctx.subagents.listDescendants(caller.id, signal);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** Teammates of the calling Lead, when the caller is in a team. */
async function listTeammates(ctx, caller) {
  const teams = teamService(ctx);
  if (teams === undefined) return { team: undefined, members: [] };
  try {
    const members = await teams.listMembers(caller);
    return { team: teams, members: Array.isArray(members) ? members : [] };
  } catch (error) {
    return { team: teams, members: [], note: errorText(error) };
  }
}

function teammateOfName(members, target) {
  return members.find((m) => m?.name === target || m?.id === target);
}

/* --------------------------------------------------------- runtime stop */

/**
 * Stop one target and release its resident instance when we can reach the
 * exact live parent. Never throws: every step is reported, not propagated.
 * @returns {Promise<string[]>} human-readable step results
 */
async function stopTarget(ctx, caller, target, { teammates } = {}) {
  const steps = [];
  if (target.kind === 'teammate') {
    if (teammates !== undefined) {
      try {
        const result = await teammates.interrupt(caller, target.name);
        steps.push(`team interrupt(${target.name}) ok${result?.previousStatus === undefined ? '' : ` (was ${result.previousStatus})`}`);
      } catch (error) {
        steps.push(`team interrupt(${target.name}) skipped: ${errorText(error)}`);
      }
    }
    try {
      await ctx.subagents.drainChildren(caller, [target.id]);
      steps.push('released resident instance');
    } catch (error) {
      steps.push(`release skipped: ${errorText(error)}`);
    }
    return steps;
  }
  try {
    await ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller });
    steps.push('interrupt ok');
  } catch (error) {
    steps.push(`interrupt skipped: ${errorText(error)}`);
  }
  let parentAgent;
  if (target.parentId === caller.id) parentAgent = caller;
  else {
    try {
      parentAgent = ctx.agents?.get?.(target.parentId);
    } catch {
      parentAgent = undefined;
    }
  }
  if (parentAgent !== undefined && parentAgent !== null) {
    try {
      await ctx.subagents.drainChildren(parentAgent, [target.id]);
      steps.push('released resident instance');
    } catch (error) {
      steps.push(`release skipped: ${errorText(error)}`);
    }
  } else {
    steps.push('release skipped: the live parent is not reachable from here');
  }
  return steps;
}

/* ---------------------------------------------------------- target lookup */

/** Resolve a name/id into `{kind, id, name?, parentId?, description?}`. */
async function resolveTarget(ctx, caller, target, signal) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('target is required');
  const wanted = target.trim();
  const { members } = await listTeammates(ctx, caller);
  const member = teammateOfName(members, wanted);
  if (member !== undefined) {
    return {
      kind: 'teammate',
      id: member.id,
      name: member.name,
      parentId: caller.id,
      description: member.description,
      status: member.status,
    };
  }
  const children = await listSubagents(ctx, caller, signal);
  if (Array.isArray(children)) {
    const child = children.find((row) => row?.id === wanted);
    if (child !== undefined) {
      return {
        kind: 'subagent',
        id: child.id,
        parentId: child.parentId,
        mode: child.mode,
        description: child.label,
        status: child.activity,
        hasChildren: child.hasChildren,
      };
    }
    const byLabel = children.filter((row) => row?.label === wanted);
    if (byLabel.length === 1) {
      const only = byLabel[0];
      return {
        kind: 'subagent',
        id: only.id,
        parentId: only.parentId,
        mode: only.mode,
        description: only.label,
        status: only.activity,
        hasChildren: only.hasChildren,
      };
    }
    if (byLabel.length > 1) {
      throw new Error(`"${wanted}" matches ${byLabel.length} subagents; pass the session id instead: ${byLabel.map((r) => r.id).join(', ')}`);
    }
  }
  throw new Error(`no teammate or live subagent named "${wanted}" under this conversation`);
}

/* ------------------------------------------------------- storage surgery */

/** Records to retire in the parent log for one removed target. */
function selector(target) {
  const { id, name } = target;
  return (event) => {
    const data = event?.data;
    if (data === null || typeof data !== 'object') return null;
    if (event.type === 'subagent/catalog') {
      if (data.childId === id) return { kind: 'subagent/catalog', subagentId: id };
      if (Array.isArray(data.entries)) {
        const kept = data.entries.filter((entry) => entry?.childId !== id && entry?.id !== id);
        if (kept.length !== data.entries.length) {
          return kept.length === 0
            ? { kind: 'subagent/catalog', subagentId: id }
            : { kind: 'subagent/catalog:entry', subagentId: id, entries: kept };
        }
      }
      return null;
    }
    if (event.type === 'team/member') {
      const member = data.member;
      if (member === null || typeof member !== 'object') return null;
      if (member.id === id || (name !== undefined && member.name === name)) {
        return { kind: 'team/member', memberId: member.id, memberName: member.name };
      }
    }
    return null;
  };
}

/** JSON-stringify one retired record, honouring the entry-filter variant. */
function retireLine(select, event) {
  const details = select(event);
  if (details === null || details === undefined) return null;
  const data = { retiredBy: 'dsh-agent-manager', retiredAt: Date.now(), originalType: event.type, ...details };
  return JSON.stringify({ type: RETIRE_TYPE, seq: event.seq, time: event.time, ignorable: true, data });
}

/** Rewrite one log in place: retire matching records, keep every seq. */
function retireInFile(file, select, backupDir) {
  const buf = fs.readFileSync(file);
  const decoded = decodeSessionLog(buf);
  if (decoded.undecodable > 0) throw new Error(`${path.basename(file)}: could not decode the whole frame stream`);
  const parsed = parseSessionLog(decoded.text);
  const before = parsed.events.map((entry) => entry.event.seq).join(',');
  let touched = 0;
  for (const entry of parsed.events) {
    const line = retireLine(select, entry.event);
    if (line === null) continue;
    entry.line = line;
    touched++;
  }
  if (touched === 0) return { file, retired: 0 };
  const text = [parsed.headerLine, ...parsed.events.map((entry) => entry.line)].join('\n') + '\n';
  const after = parseSessionLog(text).events.map((entry) => entry.event.seq).join(',');
  if (after !== before) throw new Error(`${path.basename(file)}: seq set changed during rewrite — aborted`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  const next = encodeSessionLog(text);
  const guard = fingerprint(file);
  const written = rewriteFileAtomic(file, next, { expect: guard });
  if (!written.ok) throw new Error(`${path.basename(file)}: file is being written (${written.reason}); retry after the session is closed`);
  return { file, retired: touched };
}

/**
 * Retire every record about `target` in the parent session log.
 * @returns {{ ok: boolean, details: string[] }}
 */
export function retireInSession(sessionId, target) {
  const found = findSessionDir(path.join(dshHome(), 'sessions'), sessionId);
  if (found === null) return { ok: false, details: [`session directory not found for ${sessionId}`] };
  const files = sessionLogFiles(found.dir);
  if (files.length === 0) return { ok: false, details: [`no session log under ${found.dir}`] };
  const backupDir = path.join(stateDir(), 'backups', timestamp(), path.basename(found.dir));
  const select = selector(target);
  const details = [];
  for (const entry of files) {
    try {
      const result = retireInFile(entry.path, select, backupDir);
      if (result.retired > 0) details.push(`retired ${result.retired} record(s) in ${path.basename(entry.path)}`);
    } catch (error) {
      details.push(`${path.basename(entry.path)}: ${errorText(error)}`);
    }
  }
  if (details.length === 0) details.push('no catalog/roster record referenced this target (already clean)');
  return { ok: true, details };
}

/** Move a child's session directory into the plugin's trash (recoverable). */
export function trashSessionDir(sessionId) {
  const found = findSessionDir(path.join(dshHome(), 'sessions'), sessionId);
  if (found === null) return 'no session directory on disk (nothing to move)';
  const target = path.join(stateDir(), 'trash', timestamp(), path.basename(found.dir));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(found.dir, target);
  return `moved session directory to ${target}`;
}

/** Delete a child's session directory for good — no trash copy, no undo. */
export function purgeSessionDir(sessionId) {
  const found = findSessionDir(path.join(dshHome(), 'sessions'), sessionId);
  if (found === null) return 'no session directory on disk (nothing to delete)';
  fs.rmSync(found.dir, { recursive: true, force: true });
  return `deleted session directory permanently: ${found.dir}`;
}

/** Trash entries, newest first: `{ dir, at, name, bytes }`. */
export function trashEntries() {
  const root = path.join(stateDir(), 'trash');
  let batches;
  try {
    batches = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const rows = [];
  for (const batch of batches) {
    const batchDir = path.join(root, batch.name);
    for (const entry of fs.readdirSync(batchDir, { withFileTypes: true })) {
      const dir = path.join(batchDir, entry.name);
      rows.push({ dir, at: batch.name, name: entry.name, bytes: directorySize(dir) });
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Delete every trash entry (permanent). @returns {{ removed: number, bytes: number }} */
export function emptyTrash() {
  const entries = trashEntries();
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
  const root = path.join(stateDir(), 'trash');
  try {
    for (const batch of fs.readdirSync(root, { withFileTypes: true })) {
      if (batch.isDirectory()) fs.rmdirSync(path.join(root, batch.name));
    }
  } catch {
    /* nothing left to tidy */
  }
  return { removed: entries.length, bytes };
}

function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

/* ----------------------------------------------------------- operations */

/** Catalog/roster records of one session, read straight from its log(s). */
export function readSessionRecords(sessionId) {
  const found = findSessionDir(path.join(dshHome(), 'sessions'), sessionId);
  if (found === null) {
    return { sessionId, teammates: [], subagents: [], details: [`session ${sessionId} is not on disk`] };
  }
  const teammates = new Map();
  const subagents = new Map();
  const details = [];
  for (const entry of sessionLogFiles(found.dir)) {
    try {
      const decoded = decodeSessionLog(fs.readFileSync(entry.path));
      if (decoded.undecodable > 0) details.push(`${path.basename(entry.path)}: partially undecodable`);
      for (const { event } of parseSessionLog(decoded.text).events) {
        const data = event?.data;
        if (data === null || typeof data !== 'object') continue;
        if (event.type === 'team/member' && data.member !== null && typeof data.member === 'object') {
          const member = data.member;
          if (typeof member.id !== 'string') continue;
          const prev = teammates.get(member.id) ?? { id: member.id };
          teammates.set(member.id, {
            ...prev,
            name: typeof member.name === 'string' ? member.name : prev.name,
            description: typeof member.description === 'string' ? member.description : prev.description,
            status: typeof member.phase === 'string' ? member.phase : prev.status,
          });
        } else if (event.type === 'subagent/catalog') {
          const rows = Array.isArray(data.entries) ? data.entries : [data];
          for (const row of rows) {
            if (row === null || typeof row !== 'object' || typeof row.childId !== 'string') continue;
            const prev = subagents.get(row.childId) ?? { id: row.childId };
            subagents.set(row.childId, {
              ...prev,
              label: typeof row.label === 'string' ? row.label : prev.label,
              mode: typeof row.mode === 'string' ? row.mode : prev.mode,
            });
          }
        }
      }
    } catch (error) {
      details.push(`${path.basename(entry.path)}: ${errorText(error)}`);
    }
  }
  return {
    sessionId,
    dir: found.dir,
    teammates: [...teammates.values()],
    subagents: [...subagents.values()],
    details,
  };
}

/** Resolve a target against log records (works for cold or already-removed agents). */
function resolveFromRecords(records, wanted) {
  const teammate = records.teammates.find((m) => m.name === wanted || m.id === wanted);
  if (teammate !== undefined) {
    return {
      kind: 'teammate',
      id: teammate.id,
      name: teammate.name,
      description: teammate.description,
      status: teammate.status,
      parentId: records.sessionId,
    };
  }
  const byId = records.subagents.find((s) => s.id === wanted);
  const byLabel = records.subagents.filter((s) => s.label === wanted);
  const child = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined);
  if (child !== undefined) {
    return {
      kind: 'subagent',
      id: child.id,
      description: child.label,
      mode: child.mode,
      parentId: records.sessionId,
    };
  }
  return null;
}

/** Live rows for one conversation; `lifecycle` says whether the agent is resident. */
async function collectAgents(ctx, caller, signal) {
  const children = await listSubagents(ctx, caller, signal);
  const { members, note } = await listTeammates(ctx, caller);
  return {
    sessionId: caller.id,
    live: true,
    subagents: Array.isArray(children)
      ? children.map((row) => ({
          id: row.id,
          label: row.label,
          mode: row.mode,
          activity: row.activity,
          parentId: row.parentId,
          depth: row.depth,
          hasChildren: row.hasChildren === true,
        }))
      : [],
    teammates: members.map((member) => ({
      id: member.id,
      name: member.name,
      description: member.description,
      status: member.status ?? member.phase,
    })),
    ...(Array.isArray(children) ? {} : { subagentsError: children.error }),
    ...(note === undefined ? {} : { teamNote: note }),
  };
}

/** Resolve live first, then fall back to the session log. */
async function resolveAnywhere(ctx, caller, target, signal) {
  try {
    return await resolveTarget(ctx, caller, target, signal);
  } catch (error) {
    if (typeof target !== 'string' || target.trim() === '') throw error;
    const records = readSessionRecords(caller.id);
    const fallback = resolveFromRecords(records, target.trim());
    if (fallback === null) throw error;
    return { ...fallback, offline: true };
  }
}

/** Stop one target (live runtime only). Never throws. */
async function performStop(ctx, caller, target) {
  const { team } = await listTeammates(ctx, caller);
  const steps = await stopTarget(ctx, caller, target, { teammates: team });
  return { target, steps };
}

/** Remove one target: runtime stop (when live), log retirement, then trash or purge. */
async function performRemove(ctx, caller, target, { keepFiles = false, purge = false, live = true } = {}) {
  const steps = live ? (await performStop(ctx, caller, target)).steps : ['skipped: the conversation is not running in this host'];
  const parentId = target.parentId ?? caller.id;
  const retired = retireInSession(parentId, target);
  let files = 'kept (keep_files)';
  if (purge) {
    try {
      files = purgeSessionDir(target.id);
    } catch (error) {
      files = `purge failed: ${errorText(error)}`;
    }
  } else if (!keepFiles) {
    try {
      files = trashSessionDir(target.id);
    } catch (error) {
      files = `trash failed: ${errorText(error)}`;
    }
  }
  return { target, steps, retired, files, purge: purge === true };
}

/* ---------------------------------------------------------------- tools */

function describeSubagent(row) {
  const bits = [row.id, row.mode ?? '?', row.activity ?? '?'];
  if (row.label !== undefined) bits.push(String(row.label).replace(/\s+/g, ' ').slice(0, 60));
  if (row.depth !== undefined && row.depth > 1) bits.push(`depth ${row.depth}`);
  return `  ${bits.join('  |  ')}`;
}

function describeTeammate(member) {
  const bits = [member.name ?? '?', member.status ?? member.phase ?? '?', member.id ?? '?'];
  if (member.description !== undefined) bits.push(String(member.description).replace(/\s+/g, ' ').slice(0, 60));
  return `  ${bits.join('  |  ')}`;
}

export function apply(ctx) {
  const tools = ctx.tools;

  tools.register({
    name: 'agent_list',
    description:
      'List this conversation\'s subagents and Agent Teams teammates with their session ids and running state. Use before agent_stop or agent_remove.',
    parameters: parameters({}),
    output: textOutput,
    async execute(_args, exec) {
      const caller = exec.agent;
      if (caller === undefined) return { text: 'agent_list needs a conversation context (no calling agent).' };
      const view = await collectAgents(ctx, caller, exec.signal);
      const lines = [`caller session: ${view.sessionId}`];
      if (view.subagentsError === undefined) {
        lines.push(`subagents (${view.subagents.length}):`);
        lines.push(...(view.subagents.length === 0 ? ['  (none)'] : view.subagents.map(describeSubagent)));
      } else {
        lines.push(`subagents: unavailable — ${view.subagentsError}`);
      }
      lines.push(`teammates (${view.teammates.length}):`);
      lines.push(...(view.teammates.length === 0 ? ['  (none)'] : view.teammates.map(describeTeammate)));
      if (view.teamNote !== undefined) lines.push(`team note: ${view.teamNote}`);
      return { text: lines.join('\n') };
    },
  });

  tools.register({
    name: 'agent_stop',
    description:
      'Stop one subagent or teammate: cancel its running turn and release its resident instance (frees an active-subagent slot). The session and its history stay intact; use agent_remove to delete it.',
    parameters: parameters({ target: TARGET_SCHEMA }, ['target']),
    output: textOutput,
    async execute(args, exec) {
      const caller = exec.agent;
      if (caller === undefined) return { text: 'agent_stop needs a conversation context (no calling agent).' };
      try {
        const resolved = await resolveAnywhere(ctx, caller, args.target, exec.signal);
        const { steps } = await performStop(ctx, caller, resolved);
        return {
          text: [
            `stopped ${resolved.kind} ${resolved.name ?? resolved.description ?? resolved.id}`,
            ...steps.map((step) => `- ${step}`),
            resolved.kind === 'teammate'
              ? 'note: the teammate is still on the roster (names are reserved forever); agent_remove deletes it.'
              : 'note: the subagent still appears in the catalog; agent_remove deletes it.',
          ].join('\n'),
        };
      } catch (error) {
        return { text: `agent_stop failed: ${errorText(error)}` };
      }
    },
  });

  tools.register({
    name: 'agent_remove',
    description:
      'Permanently remove one subagent or teammate: stop it, retire its catalog/roster records in this session\'s own log (records keep their sequence numbers as ignorable tombstones), and then move its session directory to the plugin trash — or delete it outright with purge. Irreversible from the model side; only purge destroys the files.',
    parameters: parameters(
      {
        target: TARGET_SCHEMA,
        keep_files: {
          type: 'boolean',
          description: 'Retire the catalog/roster records but leave the child session directory in place (default false: move it to the trash).',
        },
        purge: {
          type: 'boolean',
          description: 'Delete the child session directory immediately instead of moving it to the trash. No undo, no restore. Outranks keep_files.',
        },
        dry_run: { type: 'boolean', description: 'Report what would be done without touching the runtime or the log.' },
      },
      ['target'],
    ),
    output: textOutput,
    async execute(args, exec) {
      const caller = exec.agent;
      if (caller === undefined) return { text: 'agent_remove needs a conversation context (no calling agent).' };
      try {
        const resolved = await resolveAnywhere(ctx, caller, args.target, exec.signal);
        const purge = args.purge === true;
        const plan = [
          `target: ${resolved.kind} ${resolved.name ?? resolved.description ?? resolved.id} (${resolved.id})`,
          `parent session: ${resolved.parentId ?? caller.id}`,
          `keep files: ${args.keep_files === true && !purge}`,
          `purge (no trash): ${purge}`,
        ];
        if (args.dry_run === true) return { text: ['dry run — nothing changed', ...plan].join('\n') };
        const result = await performRemove(ctx, caller, resolved, { keepFiles: args.keep_files === true, purge });
        return {
          text: [
            `removed ${resolved.kind} ${resolved.name ?? resolved.description ?? resolved.id}`,
            ...plan.slice(1).map((line) => `- ${line}`),
            'runtime:',
            ...result.steps.map((step) => `- ${step}`),
            'session log:',
            ...result.retired.details.map((line) => `- ${line}`),
            `files: ${result.files}`,
            'reopen the conversation to see the updated catalog/roster.',
          ].join('\n'),
        };
      } catch (error) {
        return { text: `agent_remove failed: ${errorText(error)}` };
      }
    },
  });

  /* ------------------------------------------------------------ web ui */

  const API_PREFIX = '/agent-manager/api';
  const web = (() => {
    try {
      return ctx.get('webServer');
    } catch {
      return undefined;
    }
  })();
  if (web !== undefined && typeof web.register === 'function') registerRoutes(ctx, web, API_PREFIX);
  // `webServer` is usually still loading when this plugin applies, so wait for it.
  else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      registerRoutes(scope, scope.webServer, API_PREFIX);
    });
  }
}

/**
 * Mount the JSON API used by the header panel.
 * @param {object} ctx - plugin context
 * @param {object} web - the `webServer` service
 * @param {string} API_PREFIX - route prefix
 */
function registerRoutes(ctx, web, API_PREFIX) {
  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : '/';
          let body = {};
          if (req.method === 'POST') {
            const raw = await readRequestBody(req);
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                return sendJson(res, 400, { ok: false, error: 'request body is not JSON' });
              }
            }
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
          if (sessionId === '' && route !== '/trash') return sendJson(res, 400, { ok: false, error: 'sessionId is required' });

          const liveAgent = (() => {
            try {
              return ctx.agents?.get?.(sessionId) ?? undefined;
            } catch {
              return undefined;
            }
          })();

          if (route === '/list') {
            const records = readSessionRecords(sessionId);
            const live = liveAgent === undefined ? undefined : await collectAgents(ctx, liveAgent, undefined);
            const view =
              live === undefined
                ? { sessionId, live: false, teammates: records.teammates, subagents: records.subagents }
                : live;
            return sendJson(res, 200, { ok: true, result: { ...view, version: PLUGIN_VERSION, records: records.details.length === 0 ? undefined : records.details } });
          }

          if (route === '/stop' || route === '/remove') {
            const targetArg = typeof body.target === 'string' ? body.target.trim() : '';
            if (targetArg === '') return sendJson(res, 400, { ok: false, error: 'target is required' });
            const caller = liveAgent ?? { id: sessionId };
            const resolved = await resolveAnywhere(ctx, liveAgent ?? caller, targetArg, undefined);
            if (route === '/stop') {
              const { steps } = await performStop(ctx, liveAgent ?? caller, resolved);
              return sendJson(res, 200, { ok: true, result: { target: resolved, steps } });
            }
            const result = await performRemove(ctx, liveAgent ?? caller, resolved, {
              keepFiles: body.keepFiles === true,
              purge: body.purge === true,
              live: liveAgent !== undefined,
            });
            return sendJson(res, 200, { ok: true, result });
          }

          if (route === '/trash') {
            const entries = trashEntries();
            const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
            if (body.empty !== true) {
              return sendJson(res, 200, {
                ok: true,
                result: {
                  entries: entries.map((entry) => ({ at: entry.at, name: entry.name, bytes: entry.bytes })),
                  total: entries.length,
                  bytes,
                  version: PLUGIN_VERSION,
                  root: path.join(stateDir(), 'trash'),
                },
              });
            }
            const emptied = emptyTrash();
            return sendJson(res, 200, { ok: true, result: { ...emptied, root: path.join(stateDir(), 'trash') } });
          }

          return sendJson(res, 404, { ok: false, error: `unknown route ${route}` });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    }),
  );
}

/* ----------------------------------------------------------------- http */

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

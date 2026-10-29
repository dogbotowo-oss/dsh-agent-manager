# dsh-agent-manager

Stop **and really remove** subagents and Agent Teams teammates in DeepSeek Harness.
| 子代理 / 团队成员的管理插件：停止运行实例，并从「子代理目录」和「团队花名册」里真正移除。

The host ships no delete on either domain — `ctx.subagents` can interrupt a child
and release it, `ctx.agentTeams` keeps a *flat immutable roster* — so both lists
grow forever. This plugin adds the missing half: a model tool layer, a header
panel in the web GUI, and an offline CLI.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.1 < 0.3.0-0` (the session-log layout and the
  `agentTeams` / `subagents` services this plugin drives are from that line).
- A profile that mounts the team/subagent bundles — the stock `desktop` and
  `web` profiles do; headless profiles without `agentTeams` simply get no
  teammate rows.
- Node `^22.15 || >=24` (the offline CLI uses `node:zlib` zstd support).

Paths in this document are examples from a Windows install; nothing in the
plugin is path-specific (it resolves `DSH_HOME`, then `~/.dsh`).

## Where it lives

| what | path |
| --- | --- |
| source | `C:\Users\lin\.dsh\plugins\src\dsh-agent-manager` |
| package (installed from) | `C:\Users\lin\.dsh\plugins\packs\dsh-agent-manager-<version>.tgz` |
| installed copy | `C:\Users\lin\.dsh\profiles\desktop\node_modules\dsh-agent-manager` |
| backups / trash | `C:\Users\lin\.dsh\agent-manager\{backups,trash}\<timestamp>\` |

The profile dependency is a packed tarball (`file:…tgz`), not a `link:`: the
installed copy is a real directory, so the source tree can be moved or deleted
without breaking the app.

## UI (web GUI)

Conversation header → **代理管理** (a count badge shows «teammates · subagents»).
Click it: a panel lists every teammate (name, phase, running state) and every
subagent (label, parent, depth, running state), each with two actions:

- **停止** — interrupt the running turn and release the resident instance
  (frees an `maxActiveSubagents` slot). Nothing is deleted.
- **移除** — two clicks (the button becomes **确认移除**): stop, retire the
  catalog/roster record in the parent session log, and move the child's session
  directory to the trash.

Closing the panel: click the backdrop, press Esc, or click the header button again.

## Tools (host plugin layer)

| tool | what it does |
| --- | --- |
| `agent_list` | List this conversation's subagents and teammates with session ids and running state. |
| `agent_stop` | Cancel the running turn and release the resident instance. Nothing is deleted. |
| `agent_remove` | Stop → retire the catalog/roster records in this session's own log → move the child's session directory to the plugin's trash. `keep_files: true` leaves the files; `dry_run: true` only reports. |

Typical use in a conversation:

> 把 dft-runner 这个团队成员删掉 → `agent_remove(target: "dft-runner")`
> 只停掉那个还在跑的 subagent → `agent_stop(target: "<session id>")`

`target` accepts a teammate name (`dft-runner`), a subagent label when unique, or a
session id.

## Why rewriting a log is safe here

A session log is an append-only, zstd-framed JSONL file whose events carry a
contiguous `seq`, and `compaction/summary` records refer back to `seq` ranges.
Deleting a line would leave a hole; renumbering would slide every reference.

So nothing is deleted: the record is **retired in place** — same `seq`, same
`time`, rewritten as an unknown event type carrying `ignorable: true`:

```json
{"type":"agent-manager/retired","seq":27933,"time":1761700000000,"ignorable":true,
 "data":{"originalType":"team/member","memberId":"…","memberName":"dft-runner"}}
```

The v4 loader keeps unknown *ignorable* records verbatim, and every projection
only folds its own event type, so the catalog row and the roster entry disappear
while the event count and the `seq` set stay identical. The self-test asserts
exactly that (`npm run selftest`).

Two more guards: the original file is copied to
`$DSH_HOME/agent-manager/backups/<timestamp>/` before the rewrite, the write is
aborted if the file's size/mtime changes between read and rename (the host
appends per batch, so this only trips while the session is actually writing),
and the child's directory goes to `$DSH_HOME/agent-manager/trash/<timestamp>/`
rather than being deleted.

## Offline CLI

The tools and the panel write through a live host. When the session you want to
clean is the one being written right now, quit DSH (tray → Exit) and use the CLI
from the installed copy:

```powershell
cd C:\Users\lin\.dsh\profiles\desktop\node_modules\dsh-agent-manager
node lib/cli.js sessions
node lib/cli.js list   --session session-7cdeef91-9e50-4487-90d1-bc9c0a4ae4a4
node lib/cli.js remove --session session-7cdeef91-9e50-4487-90d1-bc9c0a4ae4a4 --target dft-runner
node lib/cli.js remove --session <id> --target <id> --keep-files --dry-run
```

## Install / rebuild

Source of truth is the src directory; after editing it, rebuild and redeploy in
one step (appends a new tarball, swaps the profile dependency, keeps the bundle
entry):

```powershell
node C:\Users\lin\.dsh\plugins\build-agent-manager.mjs
```

Then restart the desktop app — **tray → Exit**, then launch. Closing the window
only hides it, and a running host keeps the old module loaded.

Manual equivalent:

```powershell
cd C:\Users\lin\.dsh\plugins\src\dsh-agent-manager
node 'E:\DeepSeek Harness 0.2.1\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs' pack --pack-destination C:\Users\lin\.dsh\plugins\packs
& 'E:\DeepSeek Harness 0.2.1\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-agent-manager
& 'E:\DeepSeek Harness 0.2.1\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'C:\Users\lin\.dsh\plugins\packs\dsh-agent-manager-0.1.1.tgz'
```

## Limits

- Retiring the roster does **not** rewrite `team/task` history: tasks that named
  the removed member keep its id in the log (they render as unknown assignees).
- The child's conversation itself is untouched — it is moved, not shredded; put
  the trash back under `sessions/<project>/<session>/` to restore it.
- After a removal, reopen the conversation: the host keeps its in-memory
  projection until the session is reloaded.
- A removed teammate's *name* stays taken for the lifetime of the log (the
  provisioning record is what reserves it); spawn a new name instead.
- Only the flat roster is supported (there is no nested team to reconcile).

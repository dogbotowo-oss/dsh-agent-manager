/**
 * Filesystem locations shared by the plugin, the CLI and the self-test.
 * @module dsh-agent-manager/paths
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `$DSH_HOME`, defaulting to `~/.dsh` like the host does. */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

/** Root of every stored session (`$DSH_HOME/sessions/<project>/<session>/`). */
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/** This plugin's own state: backups, trash. Created on demand. */
export function stateDir() {
  const dir = path.join(dshHome(), 'agent-manager');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `YYYYMMDD-HHmmss`, used as a sortable backup/trash folder name. */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Files this extension writes under `~/.claude-speedometer/`, each tagged with
// the pid of the extension host that wrote it: the shared state's temporary
// files and every window's provider relay. The tag is what makes them safe to
// collect, since a file whose writer has exited is litter whichever window
// finds it.

import * as fs from "fs";
import * as path from "path";

/** True when a pid names a live process. `signal 0` delivers nothing and only
 *  tests for existence; EPERM means the process is there but owned by someone
 *  else, which still counts as alive. */
export function isLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Write `text` to `file` through a temporary file renamed into place, so a
 * reader never parses a half-written file. The temporary file is named by this
 * process's pid, and a failed write removes it before rethrowing rather than
 * leaving it for a sweep that could reclaim it only once this process exits.
 */
export function writeFileAtomic(
  file: string,
  text: string,
  mode: number
): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the write's own error is the one worth reporting */
    }
    throw err;
  }
}

/**
 * Remove the files in `dir` whose names match `pattern`, whose first group is
 * the pid that wrote each, once that process has exited, as a crash or a force
 * quit leaves them. Files of this process and of any live one are kept.
 */
export function sweepDeadPidFiles(dir: string, pattern: RegExp): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(pattern.exec(name)?.[1]);
    if (!pid || pid === process.pid || isLive(pid)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* another window got there first */
    }
  }
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Claude Code files a session's transcript under a folder named after the
// directory the session runs from: every character outside [a-zA-Z0-9] becomes
// "-", and a name longer than this is cut to it and suffixed with "-" and a
// hash of the path.
const FOLDER_NAME_MAX = 200;
// Resolved workspaces by session id, each with the prompt it was last confirmed
// for. Only successful lookups are cached: a miss (transcript not on disk yet,
// or no cwd in it yet) is transient, so caching it would pin the workspace to
// "-" for the leader's lifetime. Misses are retried on the next event instead.
// A hit serves the rest of its prompt without touching the disk, and each later
// prompt keeps it for as long as the directory still exists. Once that is gone
// (renamed or moved away), the session is resolved again from its transcript,
// which by then records where it went.
const cache = new Map<string, { promptId: string; workspace: string }>();

/** True when `dir` is `parent` or sits inside it. Compared segment-wise rather
 *  than with `startsWith`, so `/a/bc` does not read as being inside `/a/b`. */
export function isWithinDir(dir: string, parent: string): boolean {
  if (dir === parent) return true;
  const rel = path.relative(parent, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a Claude Code session id to its workspace directory (full path).
 *
 * Telemetry events carry no working directory, but each session's transcript
 * lives at ~/.claude/projects/<folder>/<session.id>.jsonl and records the `cwd`
 * each entry was written from. The workspace is the first of them, where the
 * session started, since later ones follow the shell into whatever directory it
 * changed to, scratch directories included.
 *
 * The folder is named after the directory the session runs from, which can
 * stop being that first one. A session resumed after its project directory was
 * renamed sits under the folder for the new name, its records still headed by
 * the old path, and a session Claude Code moves to another directory has its
 * transcript moved along. So when the folder names a recorded directory other
 * than the first, that directory is the workspace, unless it lies inside the
 * first: a worktree Claude Code makes under the project, which leaves the
 * session the project's.
 */
export function resolveWorkspace(
  sessionId: string,
  promptId: string
): string | undefined {
  const cached = cache.get(sessionId);
  if (cached) {
    if (cached.promptId === promptId) return cached.workspace;
    if (fs.existsSync(cached.workspace)) {
      cached.promptId = promptId;
      return cached.workspace;
    }
  }

  const workspace = locate(sessionId);
  if (workspace !== undefined) cache.set(sessionId, { promptId, workspace });
  return workspace;
}

/** The workspace recorded by the newest of the session's transcripts that notes
 *  any directory. One noting none is passed over: once a project directory is
 *  renamed, a process still running from the old name can write its closing
 *  metadata to a fresh transcript under the old folder, with no `cwd` in it. */
function locate(sessionId: string): string | undefined {
  for (const { file, folder } of transcriptsOf(sessionId)) {
    const { first, filedUnder } = dirsOf(file, folder);
    if (first === undefined) continue;
    return filedUnder === undefined || isWithinDir(filedUnder, first)
      ? first
      : filedUnder;
  }
  return undefined;
}

/** The session's transcripts, newest first: the one Claude Code is appending
 *  to is the most recently written. */
function transcriptsOf(
  sessionId: string
): { file: string; folder: string }[] {
  const found: { file: string; folder: string; mtimeMs: number }[] = [];
  try {
    for (const folder of fs.readdirSync(PROJECTS_DIR)) {
      const file = path.join(PROJECTS_DIR, folder, `${sessionId}.jsonl`);
      try {
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (stat) found.push({ file, folder, mtimeMs: stat.mtimeMs });
      } catch {
        /* not a directory (a stray file among the folders) */
      }
    }
  } catch {
    /* projects dir missing or unreadable */
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** True when Claude Code files a session running from `dir` under `folder`. */
function namesFolder(dir: string, folder: string): boolean {
  const name = dir.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= FOLDER_NAME_MAX) return name === folder;
  // The hash is Claude Code's own, so only the cut name is compared.
  return folder.startsWith(`${name.slice(0, FOLDER_NAME_MAX)}-`);
}

/**
 * The first `cwd` the transcript records, and the first that names `folder`
 * while still existing on disk. Existence is required because one folder name
 * can stand for several paths (`my_app` and `my-app` both become `my-app`), so
 * a project renamed between two such spellings keeps its folder, with records
 * of the old spelling heading it. The scan stops at that second directory,
 * which for a session that never moved is its first line carrying a cwd.
 */
function dirsOf(
  file: string,
  folder: string
): { first?: string; filedUnder?: string } {
  const dirs: { first?: string; filedUnder?: string } = {};
  const gone = new Set<string>(); // folder-naming paths found missing
  scanLines(file, (line) => {
    const cwd = cwdOfLine(line);
    if (cwd === undefined) return false;
    if (dirs.first === undefined) dirs.first = cwd;
    if (!namesFolder(cwd, folder) || gone.has(cwd)) return false;
    if (!fs.existsSync(cwd)) {
      gone.add(cwd);
      return false;
    }
    dirs.filedUnder = cwd;
    return true;
  });
  return dirs;
}

/**
 * Feed the transcript's lines to `visit` from the start, stopping once it
 * returns true. The lines wanted are usually near the top, but not always in
 * the opening record: a session can begin with `queue-operation` entries (which
 * carry no cwd) or a very large early record (a big pasted message, a
 * resumed/compacted history blob) that pushes the first cwd-bearing line
 * hundreds of KB in, as seen in practice. We therefore read incrementally
 * instead of from a fixed-size prefix: the common case still stops after ~1 KB,
 * and a deep line is still found.
 */
function scanLines(file: string, visit: (line: string) => boolean): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0); // trailing bytes of an as-yet-unterminated line
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      // Split on newline at the byte level so a multi-byte UTF-8 character that
      // straddles a chunk boundary is never decoded in halves.
      const buf =
        carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, n)])
          : chunk.subarray(0, n);
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, start)) !== -1) {
        if (visit(buf.toString("utf8", start, nl))) return;
        start = nl + 1;
      }
      // Carry the unterminated remainder (copied: `chunk` is reused next read).
      carry = Buffer.from(buf.subarray(start));
    }
    visit(carry.toString("utf8")); // final line with no trailing \n
  } catch {
    /* unreadable from here on: what was visited stands */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The `cwd` of one JSONL record, if it is a JSON object carrying a string cwd. */
function cwdOfLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
    if (typeof cwd === "string" && cwd) return cwd;
  } catch {
    /* not a complete JSON object (a partial or non-JSON line) */
  }
  return undefined;
}

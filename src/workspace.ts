import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Resolved workspaces by session id. Only successful lookups are cached: a miss
// (transcript not on disk yet, or no cwd in it yet) is transient, so caching it
// would pin the workspace to "-" for the leader's lifetime. Misses are retried
// on the next event instead.
const cache = new Map<string, string>();

/**
 * Resolve a Claude Code session id to its workspace directory (full path).
 *
 * Telemetry events carry no working directory, but each session's transcript
 * lives at ~/.claude/projects/<dir>/<session.id>.jsonl and records its `cwd`.
 * We locate that file and return the first cwd it records. Successful lookups
 * are cached (the leader resolves once per session as events arrive); misses
 * are not, so a not-yet-flushed transcript resolves on a later event.
 */
export function resolveWorkspace(sessionId: string): string | undefined {
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;

  let result: string | undefined;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const file = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        result = cwdOf(file);
        break;
      }
    }
  } catch {
    /* projects dir missing or unreadable */
  }

  if (result !== undefined) cache.set(sessionId, result);
  return result;
}

/**
 * Return the first `cwd` recorded in the transcript, scanning line by line from
 * the start and stopping at the first hit. The cwd is not always in the opening
 * record: a session can begin with `queue-operation` entries (which carry no
 * cwd) or a very large early record (a big pasted message, a resumed/compacted
 * history blob) that pushes the first cwd-bearing line hundreds of KB in, as
 * seen in practice. We therefore read incrementally instead of from a fixed-size
 * prefix: the common case still stops after ~1 KB, and a deep cwd is still found.
 */
function cwdOf(file: string): string | undefined {
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
        const cwd = cwdOfLine(buf.toString("utf8", start, nl));
        if (cwd) return cwd;
        start = nl + 1;
      }
      // Carry the unterminated remainder (copied: `chunk` is reused next read).
      carry = Buffer.from(buf.subarray(start));
    }
    return cwdOfLine(carry.toString("utf8")); // final line with no trailing \n
  } catch {
    return undefined;
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const cache = new Map<string, string | undefined>();

/**
 * Resolve a Claude Code session id to its workspace directory (full path).
 *
 * Telemetry events carry no working directory, but each session's transcript
 * lives at ~/.claude/projects/<dir>/<session.id>.jsonl and records its `cwd`.
 * We locate that file and return its cwd. Results are cached (the leader calls
 * this once per session as events arrive).
 */
export function resolveWorkspace(sessionId: string): string | undefined {
  if (cache.has(sessionId)) return cache.get(sessionId);

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

  cache.set(sessionId, result);
  return result;
}

/** Read the first transcript entry that carries a `cwd` and return it. */
function cwdOf(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch {
        /* truncated last line in the chunk */
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

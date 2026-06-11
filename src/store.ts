import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Snapshot, Turn, selectLatest, selectRecent } from "./types";

// A stable, user-visible location shared by every VS Code window. (os.tmpdir()
// can differ between the extension host and a terminal on macOS, so we avoid it.)
const DIR = path.join(os.homedir(), ".claude-speedometer");
const FILE = path.join(DIR, "state.json");
const BASENAME = "state.json";

/**
 * Machine-wide shared state, persisted to a single small file (bounded to the
 * most recent turns). The leader window writes it atomically; every window reads
 * and watches it, so all windows render the same speedometer.
 */
export class SpeedStore extends EventEmitter {
  private current: Snapshot | undefined;
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;

  constructor() {
    super();
    this.current = this.readFile();
  }

  static filePath(): string {
    return FILE;
  }

  /** Begin watching the shared file; emits "update" on external changes. */
  startWatching(): void {
    try {
      fs.mkdirSync(DIR, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      this.watcher = fs.watch(DIR, (_event, filename) => {
        // Ignore the leader's temp files; only react to the state file itself.
        if (filename && filename !== BASENAME) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const snap = this.readFile();
          if (snap) {
            this.current = snap;
            this.emit("update");
          }
        }, 80);
      });
    } catch {
      /* watching unavailable: leader still updates its own UI via write() */
    }
  }

  /** Leader-only: publish a new snapshot atomically and update local UI. */
  write(snap: Snapshot): void {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap), "utf8");
      fs.renameSync(tmp, FILE);
      this.current = snap;
      this.emit("update");
    } catch {
      /* best-effort */
    }
  }

  getSnapshot(): Snapshot | undefined {
    return this.current;
  }

  getLatest(): Turn | undefined {
    return selectLatest(this.current?.turns ?? [], this.current?.displayId);
  }

  getRecent(limit: number): Turn[] {
    return selectRecent(this.current?.turns ?? [], limit);
  }

  private readFile(): Snapshot | undefined {
    try {
      return JSON.parse(fs.readFileSync(FILE, "utf8")) as Snapshot;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

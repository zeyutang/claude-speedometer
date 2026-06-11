import { Aggregator } from "./aggregator";
import { OtlpReceiver } from "./receiver";
import { SpeedStore } from "./store";

const RETRY_MS = 2500;

/**
 * Owns leader election. Exactly one window at a time binds the OTLP port and
 * becomes the leader: it runs the receiver and publishes aggregated state to the
 * shared store. Other windows retry binding periodically, so when the leader
 * window closes (freeing the port) a follower seamlessly takes over, seeding its
 * aggregator from the shared store for continuity.
 */
export class LeaderManager {
  private receiver: OtlpReceiver | undefined;
  private agg: Aggregator | undefined;
  private timer: NodeJS.Timeout | undefined;
  private leader = false;
  private disposed = false;

  constructor(
    private readonly store: SpeedStore,
    private readonly port: number,
    private readonly retentionDays = 7,
    private readonly onRoleChange?: (isLeader: boolean) => void
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.tryBecomeLeader();
    if (!this.leader) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      if (this.disposed || this.leader) {
        this.clearTimer();
        return;
      }
      void this.tryBecomeLeader().then(() => {
        if (this.leader) this.clearTimer();
      });
    }, RETRY_MS);
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.disposed || this.leader) return;

    const agg = new Aggregator(this.retentionDays);
    // Seed from shared state so history survives a handover.
    const seed = this.store.getSnapshot();
    if (seed) agg.load(seed);

    const receiver = new OtlpReceiver(agg);
    try {
      await receiver.start(this.port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        console.error("[claude-speedometer] receiver error:", err);
      }
      receiver.dispose();
      return; // stay a follower
    }

    this.leader = true;
    this.agg = agg;
    this.receiver = receiver;
    agg.on("update", () => this.store.write(agg.snapshot()));
    this.onRoleChange?.(true);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.receiver?.dispose();
    this.agg?.dispose();
    this.receiver = undefined;
    this.agg = undefined;
    this.leader = false;
  }
}

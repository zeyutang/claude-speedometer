import * as http from "http";
import { Aggregator } from "./aggregator";
import { Attrs, readAttributes, readAnyValue } from "./types";

/**
 * Minimal OTLP/HTTP (http/json) receiver. Accepts log exports from Claude Code
 * on POST /v1/logs and feeds api_request / user_prompt events to the aggregator.
 * Metrics/traces endpoints are accepted and ignored so the exporter stays happy.
 */
export class OtlpReceiver {
  private server: http.Server | undefined;

  constructor(private readonly agg: Aggregator) {}

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on("error", (err) => reject(err));
      // Bind to loopback only.
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve();
      });
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const isLogs = (req.url ?? "").includes("/v1/logs");

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        req.destroy(); // guard against runaway bodies
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      // Always ack with an empty OTLP success body.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      if (!isLogs || chunks.length === 0) return;
      try {
        this.ingestLogs(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* malformed payload: ignore */
      }
    });
    req.on("error", () => {
      /* ignore */
    });
  }

  private ingestLogs(body: string): void {
    const payload = JSON.parse(body) as {
      resourceLogs?: Array<{
        resource?: { attributes?: unknown };
        scopeLogs?: Array<{
          logRecords?: Array<{
            body?: unknown;
            attributes?: unknown;
          }>;
        }>;
      }>;
    };

    for (const rl of payload.resourceLogs ?? []) {
      const resourceAttrs = readAttributes(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const rec of sl.logRecords ?? []) {
          const attrs: Attrs = { ...resourceAttrs };
          readAttributes(rec.attributes, attrs);

          const eventName =
            (attrs["event.name"] as string | undefined) ??
            (readAnyValue(rec.body) as string | undefined);
          if (!eventName) continue;

          this.agg.handleEvent(eventName, attrs);
        }
      }
    }
  }
}

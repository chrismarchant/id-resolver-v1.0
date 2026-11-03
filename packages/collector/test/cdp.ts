import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A Chrome/Chromium binary, or undefined. `CHROME_PATH` wins. */
export function findChrome(): string | undefined {
  const candidates = [process.env["CHROME_PATH"], "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p): p is string => typeof p === "string" && p !== "" && existsSync(p));
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/**
 * Minimal Chrome DevTools Protocol driver over Node's built-in WebSocket (no dependency): launch headless
 * Chrome, open one page, navigate, evaluate expressions, collect exceptions. Test-only.
 */
export class Browser {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId = "";
  readonly exceptions: string[] = [];
  readonly consoleErrors: string[] = [];

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {}

  static async launch(chrome: string): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), "idr-chrome-"));
    const proc = spawn(
      chrome,
      ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--disable-background-networking", "--disable-extensions", "--disable-component-update", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("chrome did not start")), 30_000);
      proc.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.on("exit", () => reject(new Error("chrome exited")));
    });
    const b = new Browser(proc, profile);
    await b.connect(wsUrl);
    return b;
  }

  private async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("cdp connect failed"));
    });
    this.ws.onmessage = (m: MessageEvent) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(JSON.stringify((msg.params as { exceptionDetails?: unknown }).exceptionDetails));
      } else if (msg.method === "Log.entryAdded") {
        const e = (msg.params as { entry: { level: string; text: string; source: string } }).entry;
        if (e.level === "error") this.consoleErrors.push(`${e.source}: ${e.text}`);
      }
    };
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" }, false)) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true }, false)) as { sessionId: string };
    this.sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
  }

  send(method: string, params: Record<string, unknown> = {}, inSession = true): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (inSession) msg["sessionId"] = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  /** Evaluates an expression in the page (DevTools evaluation, not page script) and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails));
    return r.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      } catch {
        // page still loading
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out waiting for " + expression);
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send("Browser.close", {}, false), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // already gone
    }
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    // Wait for Chrome to exit before removing its profile: it may still be writing to it.
    const exited = this.proc.exitCode !== null || this.proc.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => this.proc.once("exit", () => r()));
    this.proc.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A leftover temporary profile is not a test failure.
    }
  }
}

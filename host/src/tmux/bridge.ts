// U31/U32 TmuxBridge: attaches the host to the user's tmux over control mode,
// enumerates sessions, streams focused-pane bytes to the device as chunked
// TERMINAL_DATA, injects device KEYSTROKEs via send-keys, and (U32) derives a
// small ALERT_SIGNAL taxonomy from control-mode signals.
//
// Design (S3): `tmux -CC` needs a controlling pty, so the live child is
// `python3 src/tmux/tmux-pty.py tmux -L <sock> -CC attach -t <session>` (Bun.spawn,
// piped stdio). We feed the child's stdout to the pure ControlModeParser and
// speak commands (send-keys, capture-pane) by writing lines to the child's
// stdin. Out-of-band enumeration uses `tmux ... list-sessions/list-panes -F`.
//
// The bridge is the session source in tmux mode, in place of the agent-spawn
// block (host/bin/host.ts). It emits frames straight through a sink (the
// connection) rather than reusing SessionRegistry's Adapter model — tmux
// sessions aren't Adapters, so routing frames directly is the lower-churn path
// and keeps KEYSTROKE/FOCUS_SESSION handling local to the bridge.
//
// Testability: the pty child and the tmux CLI are injected via a TmuxRunner
// seam, so unit tests run hermetically against a fake control-mode stream and a
// fake command runner (no live tmux).

import {
  MSG,
  toHex,
  fromHex,
  encodeFrame,
  MAX_SECURE_PLAINTEXT,
  type SessionSummary,
  type TerminalDataPayload,
  type AlertClass,
} from "@agentbus/protocol";
import { ControlModeParser, type ControlEvent } from "./control-mode.ts";

export type BridgeSink = (type: number, sessionId: number, payload: unknown) => void;

// A single frame must fit MAX_SECURE_PLAINTEXT; TERMINAL_DATA hex is the only
// unbounded payload, so it's split here (same recursive verify-and-split
// discipline as registry.splitOutputText). Leaves margin for the envelope.
const TERMINAL_HEX_BUDGET = MAX_SECURE_PLAINTEXT - 64;

/** Split a TERMINAL_DATA hex payload so each frame stays under budget. */
export function splitTerminalHex(sessionId: number, hex: string, budget: number = TERMINAL_HEX_BUDGET): string[] {
  const frame = (h: string) => encodeFrame(MSG.TERMINAL_DATA, sessionId, { sessionId, hex: h } satisfies TerminalDataPayload);
  if (frame(hex).length <= budget || hex.length <= 2) return [hex];
  // Split on an even index so we never cleave a hex byte pair.
  let mid = hex.length >> 1;
  if (mid % 2 === 1) mid -= 1;
  if (mid === 0) mid = 2;
  return [...splitTerminalHex(sessionId, hex.slice(0, mid), budget), ...splitTerminalHex(sessionId, hex.slice(mid), budget)];
}

/** One live pty child speaking control mode. */
export interface ControlChild {
  /** Register the raw-stdout listener (the bridge feeds it to the parser). */
  onData(listener: (bytes: Uint8Array) => void): void;
  /** Called when the child exits (tmux detached/closed). */
  onExit(listener: () => void): void;
  /** Write a command line to the child's stdin (master pty). */
  write(line: string): void;
  /** Tear down the child. */
  kill(): void;
}

/** The tmux/pty seam. Injected so unit tests don't need a live tmux. */
export interface TmuxRunner {
  /** `tmux -L <sock> list-sessions -F '<name>:<id>'` -> lines. */
  listSessions(): string[];
  /** `tmux -L <sock> capture-pane -t <target> -e -p` -> raw screen text. */
  capturePane(target: string): string;
  /** Spawn the control-mode child (`pty.py tmux -CC attach ...`). */
  spawnControl(): ControlChild;
}

export interface TmuxBridgeOptions {
  runner: TmuxRunner;
  sink?: BridgeSink;
  /** likely_done idle threshold in ms (U32); default 30s. */
  idleThresholdMs?: number;
  /** now() seam for deterministic idle tests. */
  now?: () => number;
}

interface BridgeSession {
  id: number; // host session id (small int for the device)
  name: string; // tmux session name
  paneId: string; // "%<n>" — the pane we stream/inject for this session
  status: "idle" | "running_tool";
  lastActivity: number;
  idleAlerted: boolean;
  ended: boolean;
}

const CAP = { streaming: true, liveApproval: false, interrupt: true };

export class TmuxBridge {
  private readonly runner: TmuxRunner;
  private sink: BridgeSink | undefined;
  private readonly idleThresholdMs: number;
  private readonly now: () => number;

  private readonly parser = new ControlModeParser();
  private child: ControlChild | undefined;

  // host session id <-> tmux session name, plus per-session state.
  private readonly byId = new Map<number, BridgeSession>();
  private readonly byName = new Map<string, BridgeSession>();
  private readonly byPane = new Map<string, BridgeSession>();
  private nextId = 1;
  private focused: number | undefined;

  constructor(opts: TmuxBridgeOptions) {
    this.runner = opts.runner;
    this.sink = opts.sink;
    this.idleThresholdMs = opts.idleThresholdMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  setSink(sink: BridgeSink | undefined): void {
    this.sink = sink;
  }

  /**
   * Enumerate the tmux sessions, spawn the control-mode child, and emit the
   * initial board (per-session SESSION_STATE + a SESSION_LIST boundary). On any
   * attach failure ($TMUX/socket/nonexistent) emit a device ERROR, never hang.
   */
  start(): void {
    // Idempotent across reconnects: if the control child is already live, just
    // re-emit the board to the (new) sink rather than re-enumerating/re-spawning.
    if (this.child) {
      this.emitBoard();
      return;
    }
    let lines: string[];
    try {
      lines = this.runner.listSessions();
    } catch (err) {
      this.emit(MSG.ERROR, 0, { message: `tmux attach failed: ${(err as Error).message}` });
      return;
    }
    if (lines.length === 0) {
      this.emit(MSG.ERROR, 0, { message: "tmux attach failed: no sessions (is a tmux server running?)" });
      return;
    }

    for (const line of lines) {
      // "<name>:<id>" — the id half is tmux's $-id; we key by name.
      const name = line.slice(0, line.lastIndexOf(":")) || line;
      this.ensureSession(name);
    }
    this.emitBoard();

    let child: ControlChild;
    try {
      child = this.runner.spawnControl();
    } catch (err) {
      this.emit(MSG.ERROR, 0, { message: `tmux control-mode spawn failed: ${(err as Error).message}` });
      return;
    }
    this.child = child;
    child.onData((bytes) => this.ingest(bytes));
    child.onExit(() => this.onChildExit());
  }

  /** Emit the current screen for the focused session (KTD3 resync on attach). */
  resync(sessionId?: number): void {
    const s = sessionId !== undefined ? this.byId.get(sessionId) : this.focusedSession();
    if (!s) return;
    let screen: string;
    try {
      screen = this.runner.capturePane(s.paneId);
    } catch (err) {
      this.emit(MSG.ERROR, s.id, { message: `capture-pane failed: ${(err as Error).message}` });
      return;
    }
    this.emitTerminalData(s, new TextEncoder().encode(screen));
  }

  /** Route an inbound device frame the bridge owns (KEYSTROKE, FOCUS_SESSION). */
  route(type: number, sessionId: number, payload: unknown): void {
    if (type === MSG.FOCUS_SESSION) {
      const target = (payload as { sessionId: number }).sessionId;
      if (this.byId.has(target)) {
        this.focused = target;
        this.resync(target);
      }
      return;
    }
    if (type === MSG.KEYSTROKE) {
      const p = payload as { sessionId: number; hex: string };
      const s = this.byId.get(p.sessionId || (this.focused ?? -1));
      if (!s || !this.child) return;
      // send-keys -t <pane> -H <hex bytes as space-separated pairs>.
      const hexBytes = spacedHex(p.hex);
      this.child.write(`send-keys -t ${s.paneId} -H ${hexBytes}`);
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }

  // --- internals ---

  private ingest(bytes: Uint8Array): void {
    for (const ev of this.parser.push(bytes)) this.handle(ev);
    this.checkIdle();
  }

  private handle(ev: ControlEvent): void {
    switch (ev.kind) {
      case "output": {
        // Bind an as-yet-unseen pane to the focused session on first output
        // (single-attach: the streamed pane belongs to the attached session).
        let s = this.byPane.get(ev.paneId);
        if (!s) {
          s = this.focusedSession();
          if (!s) return;
          s.paneId = ev.paneId;
          this.byPane.set(ev.paneId, s);
        }
        s.lastActivity = this.now();
        s.idleAlerted = false;
        if (s.status !== "running_tool") {
          s.status = "running_tool";
          this.emitState(s);
        }
        this.emitTerminalData(s, ev.bytes);
        // U32: a foreground BEL byte in the pane stream is an attention alert.
        if (ev.bytes.includes(0x07)) this.emit(MSG.ALERT_SIGNAL, s.id, alert(s.id, "attention"));
        break;
      }
      case "bell": {
        // U32: background-window bell (monitor-bell). Map to the owning session.
        const s = this.focusedSession();
        if (s) this.emit(MSG.ALERT_SIGNAL, s.id, alert(s.id, "attention"));
        break;
      }
      case "exit": {
        // The whole client exited: every session ends.
        for (const s of this.byId.values()) this.endSession(s);
        break;
      }
      default:
        // begin/reply/session-changed/window-* — nothing device-facing yet.
        break;
    }
  }

  private onChildExit(): void {
    for (const s of this.byId.values()) this.endSession(s);
  }

  private endSession(s: BridgeSession): void {
    if (s.ended) return;
    s.ended = true;
    this.emit(MSG.ALERT_SIGNAL, s.id, alert(s.id, "session_ended"));
  }

  /** U32 likely_done: active-then-idle past the threshold, once per transition. */
  private checkIdle(): void {
    const t = this.now();
    for (const s of this.byId.values()) {
      if (s.ended || s.idleAlerted || s.status !== "running_tool") continue;
      if (t - s.lastActivity >= this.idleThresholdMs) {
        s.idleAlerted = true;
        s.status = "idle";
        this.emitState(s);
        this.emit(MSG.ALERT_SIGNAL, s.id, alert(s.id, "likely_done"));
      }
    }
  }

  private ensureSession(name: string): BridgeSession {
    const existing = this.byName.get(name);
    if (existing) return existing;
    const id = this.nextId++;
    // Default pane target is the session (tmux resolves to its active pane).
    // Once %output arrives we map the concrete %<n> pane to this session.
    const s: BridgeSession = {
      id,
      name,
      paneId: name, // send-keys/capture-pane accept a session name as target
      status: "idle",
      lastActivity: this.now(),
      idleAlerted: false,
      ended: false,
    };
    this.byId.set(id, s);
    this.byName.set(name, s);
    if (this.focused === undefined) this.focused = id;
    return s;
  }

  private focusedSession(): BridgeSession | undefined {
    return this.focused !== undefined ? this.byId.get(this.focused) : undefined;
  }

  private emitTerminalData(s: BridgeSession, bytes: Uint8Array): void {
    for (const hex of splitTerminalHex(s.id, toHex(bytes))) {
      this.emit(MSG.TERMINAL_DATA, s.id, { sessionId: s.id, hex } satisfies TerminalDataPayload);
    }
  }

  private emitBoard(): void {
    for (const s of this.byId.values()) this.emitState(s);
    this.emit(MSG.SESSION_LIST, 0, { sessions: this.list() });
  }

  private emitState(s: BridgeSession): void {
    this.emit(MSG.SESSION_STATE, s.id, this.summary(s));
  }

  private list(): SessionSummary[] {
    return [...this.byId.values()].map((s) => this.summary(s));
  }

  private summary(s: BridgeSession): SessionSummary {
    return { sessionId: s.id, agent: `tmux:${s.name}`, cwd: "", status: s.status, capability: CAP };
  }

  private emit(type: number, sessionId: number, payload: unknown): void {
    this.sink?.(type, sessionId, payload);
  }
}

function alert(sessionId: number, cls: AlertClass): { sessionId: number; class: AlertClass } {
  return { sessionId, class: cls };
}

// "0d0a" -> "0d 0a" for `send-keys -H`. Validated by round-tripping through
// fromHex so a malformed device payload can't inject arbitrary command text.
function spacedHex(hex: string): string {
  const bytes = fromHex(hex);
  return toHex(bytes).match(/../g)?.join(" ") ?? "";
}

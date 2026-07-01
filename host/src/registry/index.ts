// N-session registry (U7, R6, R15). Keyed sessions multiplexed over one
// connection; the registry maps normalized AdapterEvents to AgentBus frames,
// tags them with the session id, records them for replay, and forwards them to
// a sink (a connection). session_list drives the board.

import { MSG, type SessionStatus, type SessionSummary } from "@agentbus/protocol";
import type { Adapter, AdapterEvent, ApprovalDecision } from "../adapters/interface.ts";
import { DurableBuffer, type ReplayResult } from "./durable.ts";

export type FrameSink = (type: number, sessionId: number, payload: unknown) => void;

interface RegistrySession {
  id: number;
  agent: string;
  cwd: string;
  status: SessionStatus;
  adapter: Adapter;
}

export class SessionRegistry {
  private sessions = new Map<number, RegistrySession>();
  private nextId = 1;
  private focused: number | undefined;
  private sink: FrameSink | undefined;
  private buffer = new DurableBuffer();

  /** Where emitted frames go (typically a Connection.send). */
  setSink(sink: FrameSink | undefined): void {
    this.sink = sink;
  }

  create(agent: string, cwd: string, adapter: Adapter): number {
    const id = this.nextId++;
    const session: RegistrySession = { id, agent, cwd, status: "idle", adapter };
    this.sessions.set(id, session);
    adapter.onEvent((event) => this.handleEvent(id, event));
    if (this.focused === undefined) this.focused = id;
    this.emit(MSG.SESSION_STATE, id, this.summary(session));
    this.emitSessionList();
    return id;
  }

  close(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    void session.adapter.stop();
    this.sessions.delete(id);
    if (this.focused === id) this.focused = this.sessions.keys().next().value;
    this.emitSessionList();
  }

  focus(id: number): void {
    if (this.sessions.has(id)) this.focused = id;
  }

  get focusedId(): number | undefined {
    return this.focused;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  has(id: number): boolean {
    return this.sessions.has(id);
  }

  /** Route an inbound device frame to the right session. */
  route(type: number, sessionId: number, payload: unknown): void {
    if (type === MSG.FOCUS_SESSION) {
      const target = (payload as { sessionId: number }).sessionId;
      this.focus(target);
      return;
    }
    const target = sessionId || this.focused;
    if (target === undefined) return;
    const session = this.sessions.get(target);
    if (!session) return;

    switch (type) {
      case MSG.PROMPT_TEXT:
        void session.adapter.prompt((payload as { text: string }).text);
        break;
      case MSG.APPROVAL_RESPONSE: {
        const p = payload as { approvalId: string; decision: ApprovalDecision };
        session.adapter.resolveApproval(p.approvalId, p.decision);
        break;
      }
      case MSG.INTERRUPT:
        session.adapter.interrupt();
        break;
    }
  }

  /** Replay everything after a cursor (reconnect). */
  replay(cursor: number): ReplayResult {
    return this.buffer.replaySince(cursor);
  }

  private handleEvent(id: number, event: AdapterEvent): void {
    const session = this.sessions.get(id);
    if (!session) return;
    switch (event.kind) {
      case "output":
        this.emit(MSG.OUTPUT_CHUNK, id, { text: event.text });
        break;
      case "status":
        session.status = event.status;
        this.emit(MSG.SESSION_STATE, id, this.summary(session));
        break;
      case "approval":
        session.status = "awaiting_approval";
        this.emit(MSG.APPROVAL_REQUEST, id, {
          approvalId: event.approvalId,
          tool: event.tool,
          detail: event.detail,
          risk: event.risk,
        });
        this.emit(MSG.SESSION_STATE, id, this.summary(session));
        break;
      case "error":
        this.emit(MSG.ERROR, id, { message: event.message });
        break;
      case "done":
        session.status = event.status;
        this.emit(MSG.SESSION_STATE, id, this.summary(session));
        break;
    }
  }

  private emit(type: number, sessionId: number, payload: unknown): void {
    this.buffer.record(type, sessionId, payload);
    this.sink?.(type, sessionId, payload);
  }

  private emitSessionList(): void {
    this.emit(MSG.SESSION_LIST, 0, { sessions: this.list() });
  }

  private summary(s: RegistrySession): SessionSummary {
    return {
      sessionId: s.id,
      agent: s.agent,
      cwd: s.cwd,
      status: s.status,
      capability: s.adapter.capability,
    };
  }
}

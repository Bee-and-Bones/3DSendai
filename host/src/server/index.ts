// Token-gated AgentBus TCP server (U3), with an optional PSK-encrypted
// transport (U25). Binds loopback by default; refuses a non-loopback bind
// without a token or PSK. The first frame on any connection must be a valid
// ATTACH or the connection is closed before any prompt is processed.
//
// When a PSK is configured the host mints a random 8-byte epoch per
// connection, writes it cleartext as the first bytes, and thereafter every
// frame in both directions is one AEAD record under a u32 BE length prefix.
// Anything that fails to decrypt drops the connection — no plaintext error
// frame ever leaks.

import type { Socket, TCPSocketListener } from "bun";
import {
  MSG,
  AGENTBUS_VERSION,
  cryptoReady,
  sealRecord,
  openRecord,
  lengthPrefix,
  SecureRecordDecoder,
  MAX_SECURE_RECORD,
  EPOCH_BYTES,
  DIR_DOWN,
  DIR_UP,
  type Frame,
} from "@agentbus/protocol";
import { Connection, type ByteSink } from "./connection.ts";
import { assertBindAllowed, verifyAttach } from "./auth.ts";

export interface ServerConfig {
  host?: string;
  port: number;
  token?: string;
  /** 32-byte pre-shared key; when set, the transport is encrypted (U25). */
  psk?: Uint8Array;
}

export interface ServerHandlers {
  /** Called once a connection authenticates. */
  onAttach?(payload: unknown, conn: Connection): void;
  /** Called for every post-attach frame. */
  onFrame(frame: Frame, conn: Connection): void;
}

/**
 * ByteSink that seals each flushed frame as one AEAD record (host->device,
 * DIR_DOWN, sendSeq++). It always accepts the plaintext in full — so the
 * Connection queue never coalesces frames across records — and buffers sealed
 * bytes against socket backpressure itself (flushed again on socket drain).
 */
// If the device stalls, sealed bytes accumulate in `pending`. Bound it so one
// wedged client can't grow host memory without limit — past the watermark the
// connection is dropped (reconnect starts a fresh, drained session).
const SINK_HIGH_WATERMARK = 8 * 1024 * 1024;

class EncryptingSink implements ByteSink {
  private pending: Uint8Array = new Uint8Array(0);
  private sendSeq = 0n;

  constructor(
    private readonly socket: Socket,
    private readonly key: Uint8Array,
    private readonly epoch: bigint,
    private readonly onFatal: (reason: string) => void,
  ) {}

  write(frameBytes: Uint8Array): number {
    const record = sealRecord(this.key, DIR_DOWN, this.epoch, this.sendSeq, frameBytes);
    // Output is chunked upstream (registry.splitOutputText), so an over-cap
    // record is a host bug, not device input. Drop the connection rather than
    // ship a record the 3DS can't buffer (which would silently wedge it).
    if (record.length > MAX_SECURE_RECORD) {
      this.onFatal(`sealed record ${record.length} exceeds device buffer ${MAX_SECURE_RECORD}`);
      return frameBytes.length;
    }
    this.sendSeq += 1n;
    this.pending = concat(this.pending, lengthPrefix(record));
    if (this.pending.length > SINK_HIGH_WATERMARK) {
      this.onFatal(`send buffer over ${SINK_HIGH_WATERMARK} bytes — device not draining`);
      return frameBytes.length;
    }
    this.flushPending();
    return frameBytes.length;
  }

  /** The socket signalled it can accept more bytes. */
  onDrain(): void {
    this.flushPending();
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const accepted = this.socket.write(this.pending);
    if (accepted <= 0) return; // socket busy/errored — keep pending intact for the next drain
    this.pending = accepted >= this.pending.length ? new Uint8Array(0) : this.pending.slice(accepted);
  }
}

/** Per-connection encrypted-transport state; absent on the plaintext path. */
interface SecureTransport {
  epoch: bigint;
  recvSeq: bigint;
  decoder: SecureRecordDecoder;
  sink: EncryptingSink;
}

interface ConnState {
  conn: Connection;
  authed: boolean;
  secure?: SecureTransport;
  attachTimer?: ReturnType<typeof setTimeout>;
}

// A peer that connects but never sends a valid ATTACH holds a slot forever.
// Drop it after this window so a stall (or a probe) can't accumulate sockets.
const ATTACH_TIMEOUT_MS = 10_000;

export interface RunningServer {
  readonly port: number;
  stop(): void;
}

export async function createServer(config: ServerConfig, handlers: ServerHandlers): Promise<RunningServer> {
  const host = config.host ?? "127.0.0.1";
  const psk = config.psk;
  assertBindAllowed(host, config.token, psk);
  if (psk) await cryptoReady();

  const states = new Map<Socket, ConnState>();

  const route = (socket: Socket, frame: Frame, conn: Connection): void => {
    const st = states.get(socket);
    if (!st) return;
    if (!st.authed) {
      if (frame.type !== MSG.ATTACH) {
        conn.send(MSG.ERROR, 0, { message: "expected attach" });
        socket.end();
        return;
      }
      const token = (frame.payload as { token?: string } | null)?.token;
      const check = verifyAttach(config.token, token);
      if (!check.ok) {
        conn.send(MSG.ERROR, 0, { message: check.reason ?? "unauthorized" });
        socket.end();
        return;
      }
      st.authed = true;
      if (st.attachTimer) clearTimeout(st.attachTimer);
      conn.send(MSG.HELLO, 0, { version: AGENTBUS_VERSION, server: "3dsendai" });
      handlers.onAttach?.(frame.payload, conn);
      return;
    }
    handlers.onFrame(frame, conn);
  };

  /** Drop a connection that failed the secure transport — no error frame. */
  const drop = (socket: Socket, st: ConnState): void => {
    if (st.attachTimer) clearTimeout(st.attachTimer);
    st.conn.close();
    socket.end();
  };

  const listener: TCPSocketListener = Bun.listen<undefined>({
    hostname: host,
    port: config.port,
    socket: {
      open(socket) {
        let sink: ByteSink = { write: (bytes) => socket.write(bytes) };
        let secure: SecureTransport | undefined;
        if (psk) {
          const epochBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(EPOCH_BYTES));
          const epoch = new DataView(epochBytes.buffer, epochBytes.byteOffset, EPOCH_BYTES).getBigUint64(0, false);
          socket.write(epochBytes); // the only cleartext bytes on the wire
          const encrypting = new EncryptingSink(socket, psk, epoch, (reason) => {
            console.error(`dropping encrypted connection: ${reason}`);
            const s = states.get(socket);
            if (s) drop(socket, s);
            else socket.end();
          });
          sink = encrypting;
          secure = { epoch, recvSeq: 0n, decoder: new SecureRecordDecoder(), sink: encrypting };
        }
        const conn = new Connection(sink, (frame, c) => route(socket, frame, c));
        const attachTimer = setTimeout(() => {
          const s = states.get(socket);
          if (s && !s.authed) drop(socket, s);
        }, ATTACH_TIMEOUT_MS);
        states.set(socket, { conn, authed: false, secure, attachTimer });
      },
      data(socket, data) {
        const st = states.get(socket);
        if (!st) return;
        const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (st.secure && psk) {
          let records: Uint8Array[];
          try {
            records = st.secure.decoder.push(chunk);
          } catch {
            // Zero/oversized declared length: drop before buffering it.
            drop(socket, st);
            return;
          }
          for (const record of records) {
            const plain = openRecord(psk, DIR_UP, st.secure.epoch, st.secure.recvSeq, record);
            if (!plain) {
              // Wrong key, replay, reorder, or splice — drop silently.
              drop(socket, st);
              return;
            }
            st.secure.recvSeq += 1n;
            try {
              st.conn.feed(plain);
            } catch {
              // Malformed inner frame; the error frame is sealed by the sink.
              st.conn.send(MSG.ERROR, 0, { message: "malformed frame" });
              socket.end();
              return;
            }
          }
          return;
        }
        try {
          st.conn.feed(chunk);
        } catch {
          st.conn.send(MSG.ERROR, 0, { message: "malformed frame" });
          socket.end();
        }
      },
      drain(socket) {
        const st = states.get(socket);
        st?.secure?.sink.onDrain();
        st?.conn.onDrain();
      },
      close(socket) {
        const st = states.get(socket);
        if (st?.attachTimer) clearTimeout(st.attachTimer);
        st?.conn.close();
        states.delete(socket);
      },
      error(socket) {
        const st = states.get(socket);
        if (st?.attachTimer) clearTimeout(st.attachTimer);
        st?.conn.close();
        states.delete(socket);
      },
    },
  });

  return {
    port: listener.port,
    stop: () => listener.stop(true),
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Token-gated AgentBus TCP server (U3). Binds loopback by default; refuses a
// non-loopback bind without a token. The first frame on any connection must be
// a valid ATTACH or the connection is closed before any prompt is processed.

import type { Socket, TCPSocketListener } from "bun";
import { MSG, AGENTBUS_VERSION, type Frame } from "@agentbus/protocol";
import { Connection } from "./connection.ts";
import { assertBindAllowed, verifyAttach } from "./auth.ts";

export interface ServerConfig {
  host?: string;
  port: number;
  token?: string;
}

export interface ServerHandlers {
  /** Called once a connection authenticates. */
  onAttach?(payload: unknown, conn: Connection): void;
  /** Called for every post-attach frame. */
  onFrame(frame: Frame, conn: Connection): void;
}

interface ConnState {
  conn: Connection;
  authed: boolean;
}

export interface RunningServer {
  readonly port: number;
  stop(): void;
}

export function createServer(config: ServerConfig, handlers: ServerHandlers): RunningServer {
  const host = config.host ?? "127.0.0.1";
  assertBindAllowed(host, config.token);

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
      conn.send(MSG.HELLO, 0, { version: AGENTBUS_VERSION, server: "ag3nt" });
      handlers.onAttach?.(frame.payload, conn);
      return;
    }
    handlers.onFrame(frame, conn);
  };

  const listener: TCPSocketListener = Bun.listen<undefined>({
    hostname: host,
    port: config.port,
    socket: {
      open(socket) {
        const conn = new Connection(
          { write: (bytes) => socket.write(bytes) },
          (frame, c) => route(socket, frame, c),
        );
        states.set(socket, { conn, authed: false });
      },
      data(socket, data) {
        const st = states.get(socket);
        if (!st) return;
        try {
          st.conn.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } catch {
          st.conn.send(MSG.ERROR, 0, { message: "malformed frame" });
          socket.end();
        }
      },
      drain(socket) {
        states.get(socket)?.conn.onDrain();
      },
      close(socket) {
        states.get(socket)?.conn.close();
        states.delete(socket);
      },
      error(socket) {
        states.get(socket)?.conn.close();
        states.delete(socket);
      },
    },
  });

  return {
    port: listener.port,
    stop: () => listener.stop(true),
  };
}

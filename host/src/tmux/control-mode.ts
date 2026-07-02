// U31 tmux control-mode parser (pure, no I/O). Streaming: .push(bytes) buffers
// partial CRLF-terminated lines and returns the ControlEvents completed by this
// chunk. Built test-first from the S3 capture
// (host/test/fixtures/tmux-cc/attach-output-window-session.raw).
//
// Wire shape (confirmed by the fixture, see fixtures/tmux-cc/README.md):
//   - Lines end in CRLF ("\r\n"); we split on \r?\n and buffer the tail.
//   - Command replies frame as: %begin <ts> <num> <flags> / <reply lines> /
//     %end <ts> <num> <flags>  (or %error <...> in place of %end). Matched by num.
//   - %output %<paneId> <data> where <data> is the raw pane bytes
//     backslash-octal-escaped (\ooo, 1-3 octal digits; \\ = backslash). We
//     unescape back to the exact Uint8Array the pane emitted.
//   - Other %-notifications are surfaced as typed events; unknown %-lines are a
//     benign "unknown" event, never fatal.
// The DCS/ST terminal-mode wrapper (\033P1000p ... \033\\) around the stream is
// stripped as noise.

export type ControlEvent =
  | { kind: "begin"; num: number }
  | { kind: "reply"; num: number; error: boolean; lines: string[] }
  | { kind: "output"; paneId: string; bytes: Uint8Array }
  | { kind: "session-changed"; sessionId: string; name: string }
  | { kind: "session-window-changed"; sessionId: string; windowId: string }
  | { kind: "window-add"; windowId: string }
  | { kind: "window-close"; windowId: string }
  | { kind: "window-renamed"; windowId: string; name: string }
  | { kind: "layout-change"; windowId: string }
  | { kind: "bell"; windowId: string }
  | { kind: "exit"; reason: string }
  | { kind: "unknown"; line: string };

interface PendingReply {
  num: number;
  lines: string[];
}

export class ControlModeParser {
  private buf = "";
  private pending: PendingReply | undefined;

  /** Feed raw master-pty bytes; returns events completed by this chunk. */
  push(bytes: Uint8Array): ControlEvent[] {
    this.buf += DECODER.decode(bytes, { stream: true });
    const events: ControlEvent[] = [];
    let nl: number;
    // Split on LF; tolerate optional CR. Keep the trailing partial line buffered.
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line, events);
    }
    return events;
  }

  private consumeLine(line: string, out: ControlEvent[]): void {
    // Inside a %begin block: accumulate reply lines until %end / %error.
    if (this.pending) {
      if (line.startsWith("%end ") || line.startsWith("%error ") || line === "%end" || line === "%error") {
        const error = line.startsWith("%error");
        out.push({ kind: "reply", num: this.pending.num, error, lines: this.pending.lines });
        this.pending = undefined;
        return;
      }
      this.pending.lines.push(stripWrapper(line));
      return;
    }

    const clean = stripWrapper(line);
    if (clean === "") return;
    if (clean[0] !== "%") {
      out.push({ kind: "unknown", line: clean });
      return;
    }

    if (clean.startsWith("%begin ")) {
      const num = numField(clean, 2);
      this.pending = { num, lines: [] };
      out.push({ kind: "begin", num });
      return;
    }
    if (clean.startsWith("%output ")) {
      out.push(parseOutput(clean));
      return;
    }
    if (clean.startsWith("%session-changed ")) {
      const [sessionId, name] = tail(clean, 1);
      out.push({ kind: "session-changed", sessionId, name });
      return;
    }
    if (clean.startsWith("%session-window-changed ")) {
      const [sessionId, windowId] = tail(clean, 1);
      out.push({ kind: "session-window-changed", sessionId, windowId });
      return;
    }
    if (clean.startsWith("%window-add ")) {
      out.push({ kind: "window-add", windowId: field(clean, 1) });
      return;
    }
    if (clean.startsWith("%window-close ") || clean.startsWith("%unlinked-window-close ")) {
      out.push({ kind: "window-close", windowId: field(clean, 1) });
      return;
    }
    if (clean.startsWith("%window-renamed ")) {
      const [windowId, name] = tail(clean, 1);
      out.push({ kind: "window-renamed", windowId, name });
      return;
    }
    if (clean.startsWith("%layout-change ")) {
      out.push({ kind: "layout-change", windowId: field(clean, 1) });
      return;
    }
    if (clean.startsWith("%bell ") || clean === "%bell") {
      out.push({ kind: "bell", windowId: field(clean, 1) });
      return;
    }
    if (clean === "%exit" || clean.startsWith("%exit ")) {
      out.push({ kind: "exit", reason: clean.length > 5 ? clean.slice(6) : "" });
      return;
    }
    out.push({ kind: "unknown", line: clean });
  }
}

const DECODER = new TextDecoder("latin1"); // 1 byte -> 1 code unit, lossless

// Strip the DCS/ST terminal-mode wrapper tmux -CC emits around the stream:
// leading ESC P 1000 p, trailing ESC \. Only affects the boundary lines.
function stripWrapper(line: string): string {
  let s = line;
  const dcs = s.indexOf("P1000p");
  if (dcs >= 0) s = s.slice(dcs + 7);
  const st = s.indexOf("\\");
  if (st >= 0) s = s.slice(0, st) + s.slice(st + 2);
  return s;
}

// Split "%output %<paneId> <escaped-data>" preserving spaces inside the data.
function parseOutput(line: string): ControlEvent {
  // line = "%output %0 <data...>"; data starts after the 2nd space.
  const first = line.indexOf(" ");
  const second = line.indexOf(" ", first + 1);
  const paneId = line.slice(first + 1, second < 0 ? undefined : second);
  const data = second < 0 ? "" : line.slice(second + 1);
  return { kind: "output", paneId, bytes: unescapeOctal(data) };
}

// Unescape tmux control-mode octal: \ooo (1-3 octal digits) and \\ -> raw bytes.
// Input is a latin1 string (1 char == 1 byte); output is the exact byte stream.
function unescapeOctal(data: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c !== 0x5c) {
      out.push(c & 0xff);
      continue;
    }
    // Backslash: either \\ or up to 3 octal digits.
    const next = data.charCodeAt(i + 1);
    if (next === 0x5c) {
      out.push(0x5c);
      i += 1;
      continue;
    }
    let j = i + 1;
    let val = 0;
    let n = 0;
    while (n < 3 && j < data.length) {
      const d = data.charCodeAt(j);
      if (d < 0x30 || d > 0x37) break; // not an octal digit
      val = val * 8 + (d - 0x30);
      j += 1;
      n += 1;
    }
    if (n === 0) {
      // Lone backslash with no octal/backslash following: keep it literally.
      out.push(0x5c);
      continue;
    }
    out.push(val & 0xff);
    i = j - 1;
  }
  return Uint8Array.from(out);
}

// Whitespace-split helpers over a control line.
function field(line: string, index: number): string {
  const parts = line.split(" ");
  return parts[index] ?? "";
}

function numField(line: string, index: number): number {
  return Number(field(line, index));
}

// Returns [parts[index], parts[index+1..] joined] — for "%notify <a> <b c d>"
// lines where the final field can contain spaces (e.g. a session/window name).
function tail(line: string, index: number): [string, string] {
  const parts = line.split(" ");
  const a = parts[index] ?? "";
  const rest = parts.slice(index + 1).join(" ");
  return [a, rest];
}

// Macropad intent -> keystroke resolution for terminal mode (U36, KTD7).
//
// The v1 macropad path maps a `.pad` button's INTENT to the raw key BYTES sent
// into the tmux pane — NOT to an English agent prompt (that's `layouts/intent.ts`,
// which is structured-mode only and does not apply here). "approve" becomes the
// bytes `y\r`, "interrupt" becomes Ctrl-C (0x03), and so on. Buttons carry the
// resolved bytes as hex so the device can fire a KEYSTROKE frame verbatim without
// the host being in the loop per tap (device-sends-literal, stateless host).

import type { MacropadButton, MacropadLayoutPayload } from "@agentbus/protocol";
import { toHex } from "@agentbus/protocol";
import type { PadLayout } from "../layouts/load.ts";

const enc = new TextEncoder();

// Fixed vocabulary of terminal intents -> key bytes. `literal:<text>` sends the
// text verbatim; `literal:<text>\n` is common (append a carriage return with the
// `_enter` variants or an explicit \r in the text).
const FIXED: Record<string, Uint8Array> = {
	approve: enc.encode("y\r"),
	deny: enc.encode("n\r"),
	yes: enc.encode("y\r"),
	no: enc.encode("n\r"),
	enter: enc.encode("\r"),
	interrupt: Uint8Array.of(0x03), // Ctrl-C
	eof: Uint8Array.of(0x04), // Ctrl-D
	escape: Uint8Array.of(0x1b),
	tab: Uint8Array.of(0x09),
	up: enc.encode("\x1b[A"),
	down: enc.encode("\x1b[B"),
	right: enc.encode("\x1b[C"),
	left: enc.encode("\x1b[D"),
};

/**
 * Resolve a `.pad` intent to raw key bytes, or null if unknown.
 * - a fixed intent name (see FIXED), or
 * - `literal:<text>` — the UTF-8 bytes of <text> (supports `\r`, `\n`, `\t`, `\\`).
 */
export function resolveKeys(intent: string): Uint8Array | null {
	if (intent in FIXED) return FIXED[intent]!;
	if (intent.startsWith("literal:")) {
		return enc.encode(unescapeLiteral(intent.slice("literal:".length)));
	}
	return null;
}

function unescapeLiteral(s: string): string {
	return s.replace(
		/\\[rnt\\]/g,
		(m) => ({ "\\r": "\r", "\\n": "\n", "\\t": "\t", "\\\\": "\\" })[m]!,
	);
}

/**
 * Build a MACROPAD_LAYOUT payload from a `.pad` file for terminal mode. Each
 * button carries `keys` (hex) resolved from its intent; buttons whose intent
 * doesn't resolve are dropped (fail-safe — no button silently sends nothing).
 */
export function padToMacropadLayout(pad: PadLayout): MacropadLayoutPayload {
	const buttons: MacropadButton[] = [];
	for (const b of pad.buttons) {
		const keys = resolveKeys(b.intent);
		if (keys === null) continue;
		buttons.push({ id: b.id, label: b.label, intent: b.intent, keys: toHex(keys) });
	}
	return { state: "idle", buttons };
}

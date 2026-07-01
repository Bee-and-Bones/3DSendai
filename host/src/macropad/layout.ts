// Host-side state -> macropad_layout emitter (U8, R10). The device renders
// whatever layout the host pushes for the focused session's state; this is the
// producer the M2 board (U13) consumes.

import type { Capability, MacropadButton, MacropadLayoutPayload, MacropadState } from "@agentbus/protocol";

export interface LayoutContext {
  capability?: Capability;
  /** Saved prompt snippets shown when idle. */
  snippets?: string[];
  /** Disambiguation candidates shown in the menu deck. */
  candidates?: MacropadButton[];
}

export function layoutForState(state: MacropadState, ctx: LayoutContext = {}): MacropadLayoutPayload {
  switch (state) {
    case "idle":
      return {
        state,
        buttons: [
          { id: "dictate", label: "Hold to talk" },
          { id: "keyboard", label: "Keyboard" },
          ...(ctx.snippets ?? []).map((s, i) => ({ id: `snippet-${i}`, label: s })),
          { id: "switch", label: "Switch agent" },
        ],
      };
    case "dictating":
      return {
        state,
        buttons: [
          { id: "stop", label: "Release to send" },
          { id: "cancel", label: "Cancel" },
        ],
      };
    case "pending_approval": {
      // Only surface the approve/deny console where the agent supports it.
      if (ctx.capability && !ctx.capability.liveApproval) {
        return { state, buttons: [{ id: "dismiss", label: "Blocked" }] };
      }
      return {
        state,
        buttons: [
          { id: "allow", label: "A · Allow" },
          { id: "deny", label: "B · Deny" },
          { id: "diff", label: "Show diff" },
        ],
      };
    }
    case "menu":
      return {
        state,
        buttons:
          ctx.candidates && ctx.candidates.length > 0
            ? ctx.candidates
            : [{ id: "back", label: "Back" }],
      };
  }
}

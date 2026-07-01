// Intent resolution (U20, R22). A `.pad` button carries an AgentBus INTENT
// string like "run_tests" instead of a concrete keystroke or prompt. The same
// intent resolves for every agent so one shared layout keeps working after an
// agent swap; per-agent text can differ where it needs to, but the macro does not.

import { type MacropadButton } from "@agentbus/protocol";

type IntentMap = Record<string, Record<string, string>>;

// Concrete instruction per (intent, agent). Both agents resolve every intent;
// the text is intentionally the same here because these instructions are
// agent-neutral. Divergent phrasing goes in the per-agent slot when needed.
const INTENTS: IntentMap = {
  run_tests: {
    claude: "Run the project's test suite and report failures.",
    codex: "Run the project's test suite and report failures.",
  },
  commit_staged: {
    claude: "Commit the currently staged changes with a clear message.",
    codex: "Commit the currently staged changes with a clear message.",
  },
  summarize_diff: {
    claude: "Summarize the current git diff in a few bullet points.",
    codex: "Summarize the current git diff in a few bullet points.",
  },
};

/** Resolve an intent to a concrete instruction for the given agent. Throws on unknown intent. */
export function resolveIntent(intent: string, agent: string): string {
  const perAgent = INTENTS[intent];
  if (perAgent === undefined) {
    throw new Error(`Unknown intent "${intent}"`);
  }
  const instruction = perAgent[agent];
  if (instruction === undefined) {
    throw new Error(`Intent "${intent}" has no mapping for agent "${agent}"`);
  }
  return instruction;
}

/** Resolve a macropad button's intent for an agent, if it carries one. */
export function resolveButtonIntent(button: MacropadButton, agent: string): string | undefined {
  return button.intent === undefined ? undefined : resolveIntent(button.intent, agent);
}

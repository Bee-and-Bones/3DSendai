// Repo-grounded disambiguation of a dictated transcript (U16, AE3). Extracts the
// candidate identifier phrase from a transcript, searches the repo index, and
// returns the top matches as macropad taps so the user picks the real file
// instead of a whisper-mangled string. Empty index or no match -> [].

import { type MacropadButton } from "@agentbus/protocol";
import { RepoIndex } from "./repo-index.ts";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function disambiguate(index: RepoIndex, transcript: string, limit = 3): MacropadButton[] {
  return index.search(transcript, limit).map((match) => ({
    id: match.path,
    label: basename(match.path),
    intent: `open:${match.path}`,
  }));
}

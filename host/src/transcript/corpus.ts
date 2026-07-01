// STT bias corpus builder (U22, R24). Mines a TranscriptLog for domain terms
// that recur across sessions and turns them into a whisper initial-prompt hint,
// so the recognizer learns project vocab (libctru, citro2d, ...) over time. Terms
// seen only once are noise and are dropped; common English stopwords are filtered.

import type { TranscriptLog } from "./log.ts";

export interface BiasOptions {
  /** Minimum times a term must appear to count as domain vocab. Default 2. */
  minCount?: number;
  /** Cap on how many terms to return, most-frequent first. Default 50. */
  limit?: number;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "no",
  "not", "of", "on", "or", "she", "so", "that", "the", "their", "them", "then",
  "there", "they", "this", "to", "up", "us", "was", "we", "were", "what", "when",
  "which", "who", "will", "with", "you", "your",
]);

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue; // single chars carry no domain signal
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}

/**
 * Count term frequencies across the log's transcript/voiceText fields and return
 * the terms that repeat (>= minCount), most-frequent first, capped at limit.
 * Ties break by first appearance so output is stable.
 */
export function buildBiasList(log: TranscriptLog, opts: BiasOptions = {}): string[] {
  const minCount = opts.minCount ?? 2;
  const limit = opts.limit ?? 50;

  const counts = new Map<string, number>();
  const order = new Map<string, number>();
  let seen = 0;

  for (const record of log.all()) {
    for (const field of [record.transcript, record.voiceText]) {
      if (!field) continue;
      for (const term of tokenize(field)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
        if (!order.has(term)) order.set(term, seen++);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, limit)
    .map(([term]) => term);
}

/** Whisper initial-prompt style hint, e.g. "Vocabulary: libctru, citro2d". */
export function biasPrompt(terms: string[]): string {
  return `Vocabulary: ${terms.join(", ")}`;
}

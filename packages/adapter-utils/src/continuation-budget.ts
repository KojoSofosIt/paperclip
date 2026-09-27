import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

type ContinuationMessage = ExecutionContinuationEnvelope["messages"][number];

export type BudgetedContinuationMessage = ContinuationMessage & {
  omitted?: true;
  originalChars?: number;
};

/** Default prompt budget for full-history continuation message bodies. */
export const DEFAULT_CONTINUATION_MESSAGE_BUDGET_CHARS = 24_000;
/** The most recent messages always keep their bodies for local context. */
export const CONTINUATION_RECENT_MESSAGE_TAIL = 8;
/** Per-item cap for untrusted evidence results (tool/interaction payloads). */
export const CONTINUATION_EVIDENCE_RESULT_MAX_CHARS = 2_000;

/** Messages that carry human direction: never trimmed from a continuation. */
export function isHumanDirectionContinuationMessage(message: ContinuationMessage) {
  return message.authorType === "user" && !message.createdByRunId;
}

// Agent progress comments are the usual bulk of long threads and are
// non-authoritative evidence, so they go first; then system notices; then
// run-authored local CLI comments that only carry user attribution.
function trimRank(message: ContinuationMessage) {
  if (message.authorType === "agent") return 0;
  if (message.authorType === "system") return 1;
  return 2;
}

/**
 * Bound the rendered size of a full-history continuation. Human-authored
 * direction, origin comments and the recent tail keep their full bodies; older
 * agent/system messages become id-only stubs until the bodies fit the budget.
 */
export function budgetContinuationMessages(
  messages: ContinuationMessage[],
  options: {
    originCommentIds?: string[];
    budgetChars?: number;
    recentTail?: number;
  } = {},
): { messages: BudgetedContinuationMessage[]; omittedCount: number; omittedChars: number } {
  const budgetChars = options.budgetChars ?? DEFAULT_CONTINUATION_MESSAGE_BUDGET_CHARS;
  const unchanged = { messages, omittedCount: 0, omittedChars: 0 };
  if (!(budgetChars > 0)) return unchanged;
  let total = messages.reduce((sum, message) => sum + message.body.length, 0);
  if (total <= budgetChars) return unchanged;

  const origins = new Set(options.originCommentIds ?? []);
  const tailStart = Math.max(0, messages.length - (options.recentTail ?? CONTINUATION_RECENT_MESSAGE_TAIL));
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) =>
      index < tailStart &&
      !origins.has(message.id) &&
      !isHumanDirectionContinuationMessage(message) &&
      message.body.length > 0)
    .sort((a, b) => trimRank(a.message) - trimRank(b.message) || a.index - b.index);

  const omit = new Set<number>();
  let omittedChars = 0;
  for (const { message, index } of candidates) {
    if (total <= budgetChars) break;
    omit.add(index);
    total -= message.body.length;
    omittedChars += message.body.length;
  }
  if (omit.size === 0) return unchanged;
  return {
    messages: messages.map((message, index) =>
      omit.has(index)
        ? { ...message, body: "", omitted: true as const, originalChars: message.body.length }
        : message),
    omittedCount: omit.size,
    omittedChars,
  };
}

/** Replace an oversized evidence payload with a bounded, clearly marked preview. */
export function boundContinuationEvidenceValue(
  value: unknown,
  maxChars = CONTINUATION_EVIDENCE_RESULT_MAX_CHARS,
): unknown {
  if (value === null || value === undefined) return value;
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return value;
  }
  if (serialized === undefined || serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

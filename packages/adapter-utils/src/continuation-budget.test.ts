import { describe, expect, it } from "vitest";
import {
  boundContinuationEvidenceValue,
  budgetContinuationMessages,
} from "./continuation-budget.js";

const message = (
  id: string,
  authorType: string,
  body: string,
  extra: { createdByRunId?: string | null } = {},
) => ({
  id,
  authorType,
  authorId: `${authorType}-author`,
  createdByRunId: extra.createdByRunId ?? null,
  body,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  deleted: false,
  sourceTrust: null,
});

describe("budgetContinuationMessages", () => {
  it("returns messages unchanged when they fit the budget", () => {
    const messages = [message("a", "agent", "x".repeat(10)), message("b", "user", "y".repeat(10))];
    const result = budgetContinuationMessages(messages, { budgetChars: 100 });
    expect(result.messages).toBe(messages);
    expect(result.omittedCount).toBe(0);
  });

  it("never trims human direction, origin comments, or the recent tail", () => {
    const messages = [
      message("human-old", "user", "H".repeat(500)),
      message("origin", "agent", "O".repeat(500)),
      message("agent-1", "agent", "A".repeat(500)),
      message("system-1", "system", "S".repeat(500)),
      message("run-authored", "user", "R".repeat(500), { createdByRunId: "run-1" }),
      message("agent-2", "agent", "B".repeat(500)),
      message("tail-agent", "agent", "T".repeat(500)),
    ];
    const result = budgetContinuationMessages(messages, {
      budgetChars: 1_000,
      originCommentIds: ["origin"],
      recentTail: 1,
    });
    const byId = new Map(result.messages.map((entry) => [entry.id, entry]));
    expect(byId.get("human-old")?.body).toBe("H".repeat(500));
    expect(byId.get("origin")?.body).toBe("O".repeat(500));
    expect(byId.get("tail-agent")?.body).toBe("T".repeat(500));
    for (const id of ["agent-1", "agent-2", "system-1", "run-authored"]) {
      expect(byId.get(id)).toMatchObject({ body: "", omitted: true, originalChars: 500 });
    }
    expect(result.omittedCount).toBe(4);
    expect(result.messages.map((entry) => entry.id)).toEqual(messages.map((entry) => entry.id));
  });

  it("trims the oldest agent messages before system and run-authored messages", () => {
    const messages = [
      message("system-old", "system", "S".repeat(400)),
      message("agent-old", "agent", "A".repeat(400)),
      message("agent-newer", "agent", "B".repeat(400)),
      message("tail", "user", "U".repeat(10)),
    ];
    const result = budgetContinuationMessages(messages, { budgetChars: 900, recentTail: 1 });
    expect(result.messages.find((entry) => entry.id === "agent-old")).toMatchObject({ omitted: true });
    expect(result.messages.find((entry) => entry.id === "agent-newer")?.body).toBe("B".repeat(400));
    expect(result.messages.find((entry) => entry.id === "system-old")?.body).toBe("S".repeat(400));
    expect(result.omittedChars).toBe(400);
  });

  it("is disabled by a zero budget", () => {
    const messages = [message("a", "agent", "x".repeat(5_000))];
    expect(budgetContinuationMessages(messages, { budgetChars: 0, recentTail: 0 }).omittedCount).toBe(0);
  });
});

describe("boundContinuationEvidenceValue", () => {
  it("keeps small values and marks oversized ones as truncated previews", () => {
    expect(boundContinuationEvidenceValue({ ok: true }, 100)).toEqual({ ok: true });
    const bounded = boundContinuationEvidenceValue({ text: "z".repeat(500) }, 100) as Record<string, unknown>;
    expect(bounded.truncated).toBe(true);
    expect(bounded.originalChars).toBeGreaterThan(500);
    expect(String(bounded.preview)).toHaveLength(100);
  });
});

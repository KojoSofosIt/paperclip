import { describe, expect, it } from "vitest";
import {
  SESSION_HANDOFF_LAST_RUN_SUMMARY_MAX_CHARS,
  buildSessionHandoffMarkdown,
  classifySessionStart,
} from "../services/heartbeat.js";

const base = {
  resumed: false,
  priorSessionExisted: true,
  rotated: false,
  credentialReset: false,
  configReset: false,
  wakeReset: false,
  recovery: false,
};

describe("classifySessionStart", () => {
  it("labels a resumed session warm regardless of other signals", () => {
    expect(classifySessionStart({ ...base, resumed: true, configReset: true })).toBe("warm_resume");
  });

  it("labels a first session cold", () => {
    expect(classifySessionStart({ ...base, priorSessionExisted: false, wakeReset: true })).toBe("cold");
  });

  it.each([
    [{ rotated: true, configReset: true }, "fresh_rotation"],
    [{ credentialReset: true, configReset: true }, "fresh_credential_reset"],
    [{ configReset: true, wakeReset: true }, "fresh_config_reset"],
    [{ wakeReset: true, recovery: true }, "fresh_wake_reset"],
    [{ recovery: true }, "fresh_recovery"],
    [{}, "fresh_other"],
  ] as const)("attributes a fresh start with prior work to its first cause (%j)", (overrides, expected) => {
    expect(classifySessionStart({ ...base, ...overrides })).toBe(expected);
  });
});

describe("buildSessionHandoffMarkdown", () => {
  it("points at durable state and bounds the last run summary", () => {
    const markdown = buildSessionHandoffMarkdown({
      reason: "effective run configuration changed: instructions",
      previousSessionId: "session-1",
      previousRunId: "run-1",
      issueId: "issue-1",
      lastRunSummary: "s".repeat(SESSION_HANDOFF_LAST_RUN_SUMMARY_MAX_CHARS + 500),
      nextAction: "Run the migration tests.",
      unresolvedInteractionIds: ["interaction-1"],
      throughCommentId: "comment-9",
    });
    expect(markdown).toContain("Paperclip session handoff:");
    expect(markdown).toContain("- Fresh session reason: effective run configuration changed: instructions");
    expect(markdown).toContain("- Previous session: session-1");
    expect(markdown).toContain("- Previous run: run-1");
    expect(markdown).toContain("- Recorded next action: Run the migration tests.");
    expect(markdown).toContain("- Unresolved interactions: interaction-1");
    expect(markdown).toContain("comments through comment-9");
    expect(markdown).toContain("[truncated]");
    expect(markdown.length).toBeLessThan(SESSION_HANDOFF_LAST_RUN_SUMMARY_MAX_CHARS + 900);
  });

  it("omits empty fields", () => {
    const markdown = buildSessionHandoffMarkdown({
      reason: "wake reason is issue_assigned",
      previousSessionId: null,
      previousRunId: null,
      issueId: null,
      lastRunSummary: null,
      nextAction: null,
    });
    expect(markdown).not.toContain("Previous session");
    expect(markdown).not.toContain("Last run summary");
    expect(markdown).not.toContain("Unresolved interactions");
    expect(markdown.split("\n")).toHaveLength(3);
  });
});

/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
    /**
     * Evidence that is new or changed since the base run's envelope. The
     * resumed session already holds the rest. Absent on older snapshots, in
     * which case renderers fall back to the full evidence.
     */
    evidence?: {
      completedWorkChanged: boolean;
      interactionOutcomes: ExecutionContinuationEnvelope["interactionOutcomes"];
      completedActions: NonNullable<ExecutionContinuationEnvelope["completedActions"]>;
      recoveryOutcomes: NonNullable<ExecutionContinuationEnvelope["recoveryOutcomes"]>;
    };
  };
  /**
   * Prompt budget for full-history message bodies. Human direction, origin
   * comments and the most recent messages are never trimmed. 0 disables it.
   */
  messageBudgetChars?: number;
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  coverage: {
    kind: "full_task_history" | "task_history_delta" | "budgeted_task_history";
    baseRunId?: string;
    /** Messages rendered as id-only stubs because of the prompt budget. */
    omittedMessageCount?: number;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}

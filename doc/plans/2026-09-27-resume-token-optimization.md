# Resume token optimization plan

Date: 2026-09-27
Status: implemented (Phases 0–6; Phase 5 and 6 narrowed, Phase 7 pending data)
Builds on: [2026-03-13 Token Optimization Plan](2026-03-13-TOKEN-OPTIMIZATION-PLAN.md)
Related: [Reliable execution recovery](2026-09-08-reliable-execution-recovery.md),
[Continuation accounting baseline](2026-09-22-continuation-accounting-baseline.md),
[Continuation accounting fixes](2026-09-23-continuation-accounting-fixes.md),
`doc/execution-semantics.md`

## Goal

Lower the tokens an agent spends each time it resumes work on a task. The
resume can be caused by a timer, a comment, a retry, a recovery, a session
rotation, or a configuration change. The fix must not lose any function, weaken
approval gates, or allow unsafe replay.

## Method

1. I read the Markdown files that describe agent execution, continuation, and
   token use: `AGENTS.md`, `doc/GOAL.md`, `doc/SPEC-implementation.md`,
   `doc/execution-semantics.md`, `doc/acp-run-lifecycle.md`,
   `doc/TASK-WATCHDOG.md`, `doc/memory-landscape.md`, `doc/run-log-events.md`,
   `packages/adapters/AUTHORING.md`, `skills/paperclip/SKILL.md` and its
   `references/`, and the related plans in `doc/plans/`. The March 2026 token
   plan is the most important of these.
2. I compared each claim in the March plan with the code at commit `0f14d26`.
3. I traced the prompt that each resume path sends to the provider, from
   `server/src/services/heartbeat.ts`, through
   `packages/adapter-utils/src/server-utils.ts`, to each adapter's `execute.ts`.

The line numbers below are from commit `0f14d26`. Check them again before you
make a change.

## Status of the March 2026 plan

Most of the March plan has shipped. The remaining waste comes from other resume
paths.

| March phase | Status | Evidence |
|---|---|---|
| 1. Normalized usage telemetry | Done | `resolveNormalizedUsageForSession` computes a delta from session totals. `usageBasis: "per_run"` skips the delta (`heartbeat.ts` ~11952). Adapters emit `promptMetrics`. |
| 2. Keep sessions on timer wakes | Done | Issue-scoped timer wakes reuse the session. Only unscoped timer wakes start fresh (`shouldResetTaskSessionForWake`, `heartbeat.ts:5607`). |
| 3. Bootstrap prompt versus heartbeat prompt | Done | `bootstrapPromptTemplate` is rendered only when `!sessionId` (for example `claude-local/.../execute.ts:830-843`). Claude and Codex do not send the instructions again on resume. |
| 4. Incremental context APIs | Done | `GET /agents/me/inbox-lite`, `GET /issues/:id/heartbeat-context`, and `comments?afterCommentId=` exist. The skill has a "scoped-wake fast path". |
| 5. Session compaction and rotation | Partly done | Rotation exists (`evaluateSessionCompaction`, `heartbeat.ts:11984`), but the handoff it writes is thin. Claude, Codex, and Hermes turn off rotation (`session-compaction.ts:31-37`). |
| 6. Smaller skill surface | Partly done | `desiredSkills` allowlists exist. But `skills/paperclip/SKILL.md` grew from 17 KB to **60 KB (about 15k tokens)**. |
| (new) Measure how context is fetched | Not done | `contextFetchMode` and a full-thread-fetch counter were never added. |

## How an agent resumes today

| Path | Trigger | What the model receives |
|---|---|---|
| A. Warm resume | The provider session is valid and the config fingerprint has not changed | Resume delta: wake summary, compact task markdown, and new comments. Some items that the session already has are sent again (see F3 and F4). |
| B. Reset by wake reason | `issue_assigned`, approval requested, review-participant recovery, unscoped timer, or `forceFreshSession` | Full fresh prompt. **No carry-forward note.** |
| C. Reset by config | Model, instructions, runtime skills, secrets, env bindings, workspace, or MCP set changed (`resolveTaskSessionConfigFreshness`, `heartbeat.ts:6842`). Claude also checks the prompt bundle and MCP set (`execute.ts:817-829`). | Full fresh prompt. **No carry-forward note.** The whole thread is sent (F2). |
| D. Adapter fallback | Unknown, poisoned, or image-broken resume session, so the adapter calls `runAttempt(null)` | **The resume-delta prompt goes to a brand-new session** (F1). |
| E. Compaction rotation | Run count, raw input, or age passes a threshold (adapters that do not manage their own context) | Fresh prompt and a `handoffMarkdown` of about 1.5 KB (F5). |
| F. Recovery or replacement | Process lost, max-turns continuation, disposition repair, native replacement | Recovery wake and the full `executionContinuation` envelope (F2). |

## Findings

### F1: The fresh-session fallback reuses the resume-delta prompt (correctness and tokens)

- Claude builds `prompt` once, with `resumedSession: Boolean(sessionId)`
  (`packages/adapters/claude-local/src/server/execute.ts:844-863`). If
  `--resume` fails, it retries with `runAttempt(null)` (`:1352`) and sends the
  same prompt. The new session then gets the "Paperclip Resume Delta" text, the
  **compact** task markdown with no description, and no heartbeat template. It
  also gets no bootstrap prompt, because that was rendered only when
  `!sessionId`.
- Codex has the same problem (`codex-local/.../execute.ts:1127-1210`, retry at
  `:1566`). `promptInstructionsPrefix` is already `""` for a resume delta, so
  the fresh Codex session also starts **with no agent instructions at all**.
- Gemini, Cursor, Kimi, OpenCode, and Grok choose again only the communication
  guidance for each attempt (`gemini-local/.../execute.ts:611-615`). Their
  `basePrompt` still holds the resume variant.
- The result: the agent does not have enough context. It then calls
  `/agents/me`, heartbeat-context, and the full comment list to rebuild that
  context, which costs more tokens than a correct fresh prompt. It can also
  miss rules from its instructions.
- The comment on `selectInitialCommunicationGuidance`
  (`server-utils.ts:2161`) says that the prompt should be chosen at the attempt
  boundary. That rule is applied only in part.

### F2: The continuation envelope sends the whole thread with no limit

- `buildExecutionContinuation` (`server/src/services/execution-continuation.ts:138-147`)
  loads **every comment** on the issue with no limit. It puts each full body
  into `messages`. It also adds every interaction `result` as raw JSON (`:399-405`).
- This runs for every assigned run that is not a conversation
  (`heartbeat.ts:20733-20747`). The envelope is stored in
  `heartbeat_runs.context_snapshot` and rendered as fenced JSON in the prompt
  (`server-utils.ts:2466-2482`).
- Only warm resumes with a matching `resumeDelta` send new messages only.
  Paths B through F send the **whole history**, and each time they send more,
  because the thread keeps getting longer.
- `coverage.summaryThroughCommentId` is always `null` (`:417-421`). The data
  model already allows "a summary covers history up to comment X", but no code
  uses it.

### F3: The continuation summary is sent up to three times

- In the envelope as `completedWork`: up to 8,000 characters
  (`execution-continuation.ts:408-411`, `ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS`).
- In the wake prompt as "Issue continuation summary": up to 4,000 characters
  (`heartbeat.ts:8184-8192`, `server-utils.ts:2946-2954`). This happens **on
  warm resumes too**, even when the summary has not changed since the last run.
- In the rotation handoff: up to 1,500 characters (`heartbeat.ts:12104`).
- `objective` repeats the latest request body or the issue description. The
  task markdown also carries the description.

### F4: Warm resumes send text that the session already has

- The execution contract, a paragraph of about 1,100 characters, is added to
  **every** resume delta (`includeExecutionContract = … resumedSession`,
  `server-utils.ts:2244`). The session received it on its first turn.
- Gemini, Cursor, Kimi, and OpenCode add the **whole instructions file**
  (`instructionsPrefix`) on every run, resumed or not
  (`gemini-local/.../execute.ts:575-583`, and the same in the others).
  `paperclipEnvNote` and `apiAccessNote` are also sent again. Claude and Codex
  already skip these on resume.

### F5: Rotation and reset do not give the next session a useful handoff

- `handoffMarkdown` has only the previous session id, the rotation reason, the
  last run summary, and the first 1,500 characters of the continuation summary
  (`heartbeat.ts:12098-12112`).
- Paths B, C, and D get **no handoff**. Only Codex's transient fallback has one
  (`buildCodexTransientHandoffNote`).
- Without a structured checkpoint (objective, done, open decisions, blockers,
  files touched, next action, last seen comment id), the model rebuilds its
  context with API calls and by reading the workspace again.

### F6: Configuration changes reset sessions more than necessary

- Every category in `EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES`
  (`heartbeat.ts:5787-5798`) resets the session. This includes `secrets` and
  `envBindings`. A rotated secret value, or an env binding that the model never
  sees, has no effect on the conversation history. But it discards the provider
  cache and the session memory for every task of that agent.
- An edit to the instructions or the skills starts every task session fresh at
  the same moment. That causes a spike of full-price starts.

### F7: The Paperclip skill costs about 15k tokens on each cold start

`skills/paperclip/SKILL.md` is 60,473 bytes. The largest sections are the
heartbeat procedure (18 KB), issue-thread interactions (10 KB), key endpoints
(4 KB), authentication (3.6 KB), critical rules (3 KB), planning (2.7 KB), and
MCP approval gates (2.6 KB). Most runs need only the heartbeat fast path,
checkout, comments, and status rules. The `references/` directory already
exists as a place for the rest.

### F8: We cannot yet measure how much a resume costs

- `promptMetrics` records character counts for each prompt section. But no
  metric records *why* a session was fresh as one enum (such as wake, config,
  adapter fallback, rotation, or recovery). Nothing records how many envelope
  messages were rendered, or whether the agent then loaded the full thread.
- Without these numbers we cannot rank F1 through F7 by real cost, or show
  that a fix made things better.

## Plan

Principles (these add to the March plan):

1. Build the prompt at the attempt boundary. A fresh provider session always
   gets a fresh-session prompt.
2. Send each fact once. On a warm resume, send only what changed.
3. A fresh session gets a **bounded checkpoint and a tail of recent messages**,
   not the full history.
4. Never exchange safety for tokens. The objective, the human responses, the
   approval gates, the unresolved interactions, and the origin comments must
   always be sent in full.

### Phase 0: Measurement (small; do this first)

Changes:
- Add `sessionStartKind` to the run metadata and to `promptMetrics`. Values:
  `warm_resume | fresh_wake_reset | fresh_config_reset | fresh_adapter_fallback | fresh_rotation | fresh_recovery | cold`.
  Put it next to the `configFreshnessResultMetadata` that already exists
  (`heartbeat.ts` ~22662).
- Add `continuationMessagesRendered`, `continuationChars`,
  `continuationSummaryChars`, and `executionContractChars` to `promptMetrics`
  in `renderPaperclipWakePrompt` and in the adapters.
- Count full-thread loads for each run. In the comments route
  (`routes/issues.ts` ~15326), when a caller with an agent run id requests
  comments without `afterCommentId`, record a run-log event (`appendRunEvent`).
  This is a run-log change, so it needs no extra review under AGENTS.md §7.

Verification: unit tests for each enum value. Run it on one dev instance and
check that the metrics show every path A through F.

### Phase 1: Fix the fresh-session fallback prompt (F1; correctness, high priority)

Changes:
- In `packages/adapter-utils`, add a helper that builds the prompt for one
  `(context, resumedSession)` pair. Each adapter calls it **inside**
  `runAttempt(resumeSessionId)`. Then a fallback to `runAttempt(null)` gets:
  the bootstrap prompt, the full task markdown, the full wake payload, the
  heartbeat template, the instructions prefix (for adapters that inject it
  through the prompt), and a new fallback handoff note (see Phase 3).
- Adapters to change: claude-local, codex-local, gemini-local, cursor-local,
  kimi-local, opencode-local, grok-local, and pi-local. Check hermes
  (`buildPrompt(..., { resumedSession })`) the same way.
- Log `promptMetrics` for each attempt. Today the metrics describe only the
  first attempt.

Tests: for each adapter, add a parse and execute test in which the first
attempt returns an unknown-session error. Assert that the second attempt's
stdin or args contain the bootstrap prompt and the full task markdown, and do
not contain "Paperclip Resume Delta". For Codex, also assert that the
instructions prefix is present.

### Phase 2: A bounded continuation envelope with a checkpoint (F2 and F3; the largest saving)

Changes:
- Use `coverage.summaryThroughCommentId`. When the issue continuation summary
  document names the last comment it covers, the envelope for a **fresh**
  session contains:
  - the checkpoint (the continuation summary, sent once),
  - all `originCommentIds` and every message after the checkpoint,
  - a small tail of recent messages before the checkpoint (for example 5) to
    give local context,
  - `coverage.kind = "summary_plus_tail"`, with `omittedMessageCount` and the
    comments cursor, so the model knows how to fetch more with
    `comments?afterCommentId=`.
- Set a character budget for the rendered envelope, for example 24k characters
  that operators can configure. The items in "Principles" item 4 are always
  sent in full. When the budget is used up, trim the oldest agent-authored
  messages first, then the oldest system messages. Never trim human-authored
  messages that come after the checkpoint.
- Bound `interactionOutcomes[].result`. Keep the typed fields: answers,
  decision, status. Replace any large raw result with a reference id.
- Send the continuation summary once. Keep it as `completedWork` in the
  envelope. Remove the separate "Issue continuation summary" section from the
  wake prompt when an envelope is present. On **warm** resumes, leave the
  summary out when its `latestRevisionId` has not changed since the session's
  last run. Store the revision id in the task session params, as the resume
  delta already does for `baseRunId`.
- Write the checkpoint cursor to the summary document. When
  `refreshIssueContinuationSummary` (`issue-continuation-summary.ts:242`)
  writes the document, it also records the id of the newest comment it covered.
- Store a smaller copy in `context_snapshot`. Keep message ids and hashes. Load
  the full bodies only when the prompt is rendered. This keeps
  `heartbeat_runs` rows from growing on long threads.

Contracts to update (AGENTS.md §5.2): the `ExecutionContinuationEnvelope` type
in `packages/shared`, and the renderer in `adapter-utils`. `server` builds the
envelope. The UI has no change unless the run inspector shows coverage.

Tests: add envelope tests for a thread of 200 comments with and without a
checkpoint. Assert that the origin comments and the human responses are always
present, that the budget is respected, and that `omittedMessageCount` is
correct. Rerun the continuation-accounting and execution-recovery suites
without changing them. Their assertions must still pass.

### Phase 3: A structured handoff for every fresh start that follows prior work (F5)

Changes:
- Replace the ad hoc `handoffMarkdown` with one `buildSessionHandoff()` that
  the server uses for paths B (except `issue_assigned` for a new assignee), C,
  D, and E. It gives:
  - the reason for the fresh start (from `sessionStartKind`),
  - the previous session id and the last run id,
  - a pointer to the checkpoint (the summary revision and the cursor comment id),
  - the last run's result summary (limited, for example to 1,500 characters),
  - open items: unresolved interactions, blockers, and pending approvals (ids
    and titles only),
  - the files and work products that recent runs touched (these already exist
    as work products and as path candidates in `issue-continuation-summary.ts`),
  - the next action (`extractContinuationSummaryNextAction`).
- For path D, the adapter cannot call the server. Instead, the server always
  sends a pre-rendered `paperclipFallbackHandoffMarkdown` in the context. The
  adapter adds it only on a fresh attempt. This replaces the Codex-only
  `buildCodexTransientHandoffNote`.
- Make the continuation summary content richer (in the same document and
  within the same 8k limit). Add these fixed headings: Objective, Done,
  Decisions, Open questions, Blockers, Files/Artifacts, Next action, Covered
  through comment. The paperclip skill already asks agents to leave durable
  progress. Point that instruction at this document.

Tests: for each path, a heartbeat test asserts that the handoff is present and
bounded. Add a guard test: an `issue_assigned` wake for a *different* agent
does not include the previous assignee's session handoff.

### Phase 4: Send less on warm resumes (F4)

Changes:
- Send the execution contract on a resume only when one of these is true: the
  session has not received it yet (store a contract hash in the task session
  params), the contract text changed, or the wake is recovery or repair. In
  all other cases, add a one-line reminder: "Execution contract unchanged; a
  final disposition is still required."
- Gemini, Cursor, Kimi, and OpenCode: when their CLI resume keeps the earlier
  turns in context, skip `instructionsPrefix`, `paperclipEnvNote`, and
  `apiAccessNote` on a resume delta, as Claude and Codex do. First check, for
  each CLI, that a resumed session keeps the first-turn prompt. Record the
  result in `ADAPTER_SESSION_MANAGEMENT` as a new flag, such as
  `retainsInitialPromptOnResume`.
- Do not send the task description again on a warm resume unless it changed
  since the session's last run (compare `updatedAt` or a hash). The resume
  delta already leaves it out, but `objective` in the envelope can still carry it.

Tests: snapshot tests of `renderPaperclipWakePrompt` for a warm resume with
the contract hash present and absent. Adapter tests for the new flag.

### Phase 5: Fewer resets caused by configuration (F6)

Changes:
- Split `EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES` into two groups:
  - **Reset** categories, which change what the model believes: `adapter`,
    `model`, `instructions`, `runtimeSkills`, `workspaceConfig`, `environment`,
    and the MCP server set.
  - **Refresh-only** categories, which change the process but not the
    conversation: `secrets` values, `envBindings` values, and `issueOverrides`
    that do not touch the model or the instructions. For these, keep the
    session and add a one-line "runtime configuration refreshed" note to the
    resume delta.
- When `instructions` or `runtimeSkills` change, do not reset each task
  session at the same moment. Let each session keep going until its next
  natural boundary. Add a short "instructions updated: <diff summary or new
  hash>" note to the resume delta. The operator can still ask for an immediate
  reset (`forceFreshSession`, or a "reset all sessions" control).
  - Safety: if an instructions change removes a permission or adds a
    restriction, the operator must be able to require an immediate reset.
    Default to an immediate reset when the diff *removes* lines. Default to the
    delayed reset when lines are only added.
- Keep resetting on credential identity changes
  (`isTaskSessionCredentialCompatible`).

Tests: freshness unit tests for each category. Add a regression test that
changing a secret value does not reset the task session, and that changing a
secret *binding name* is handled as the design decides.

### Phase 6: Split the Paperclip skill (F7)

Changes:
- Rewrite `skills/paperclip/SKILL.md` as a core file of about 12–15 KB. It
  keeps: authentication, the scoped-wake fast path, checkout, incremental
  context, status and disposition rules, comment style, and the list of hot
  endpoints.
- Move these into `references/`, each loaded only when needed: issue-thread
  interactions and standalone decisions, MCP approval gates, managing a user's
  inbox, credentials and secrets, planning, routines, cases, and company skills.
  Each moved section leaves a one-line pointer in the core file.
- Follow `doc/plans/2026-03-13-paperclip-skill-tightening-plan.md` and the
  eval framework (`doc/evals.md`). Run the existing agent evals before and
  after the change so that no behavior gets worse.

Verification: the byte size, the eval pass rates, and the Phase 0
full-thread-fetch rate must not get worse.

### Phase 7: Review Claude and Codex compaction policy (F5 continued)

Claude, Codex, and Hermes are set to `nativeContextManagement: "confirmed"`,
so Paperclip never rotates them. Their CLIs compact the context automatically.
But a very long session still pays for the compacted history on every resume.
With the Phase 0 data, decide whether a high safety threshold is worth adding
(for example 400 runs or 14 days). The Phase 3 handoff would make such a
rotation cheap. This phase is a decision based on data. It is not a change to
make now.

## Rollout order

| Order | Phase | Why this order |
|---|---|---|
| 1 | Phase 0 (measurement) | Gives a baseline so each later change can be proven. |
| 2 | Phase 1 (fallback prompt) | Fixes a correctness bug. The change is small and local to the adapters. |
| 3 | Phase 3 (structured handoff) | Phase 2 needs its checkpoint cursor, and Phase 1 needs its fallback note. |
| 4 | Phase 2 (bounded envelope) | The largest saving on long threads. |
| 5 | Phase 4 (lean warm resume) | Saves a constant amount on every warm resume. |
| 6 | Phase 5 (config resets) | Changes behavior, so it is safer after the handoff exists. |
| 7 | Phase 6 (skill split) | Needs eval runs. It is independent of the other phases. |
| 8 | Phase 7 (policy decision) | Needs the data from Phase 0. |

Put each phase in its own PR behind an instance setting where it changes
behavior. Suggested settings: `heartbeat.continuation.budgetChars` and
`heartbeat.session.refreshOnlyCategories`.

## Success metrics

Collect these for each adapter, with Phase 0 as the baseline:

- Median and p90 prompt characters for each `sessionStartKind`.
- Normalized input tokens for each successful resumed run, and for each
  completed issue.
- The share of fresh starts that are caused by configuration (target: 50% fewer).
- The share of runs that load the full comment thread after the first read
  (target: below 10%).
- The size of the continuation envelope on issues with 50 or more comments
  (target: bounded by the budget, not by the thread length).

Guardrails, which must not get worse:
- the task completion rate, the rate of missing dispositions and repairs, the
  blocked-task rate, the reopen rate,
- the continuation-accounting and execution-recovery suites,
- no human-authored message after the checkpoint is ever left out.

## Risks

- **A lossy checkpoint.** A poor summary can hide a requirement. Mitigation:
  origin comments, human responses, and every message after the checkpoint are
  always sent in full. The model gets the cursor to fetch more. The summary is
  marked as untrusted evidence, as it is today.
- **Stale instructions after a delayed reset.** Mitigation: an immediate reset
  when lines are removed, the operator override, and the note in the resume
  delta.
- **Differences between adapters.** Some CLIs may not keep the first-turn
  prompt on resume. Mitigation: the per-adapter flag must be proved by a test
  before Phase 4 applies to that adapter.
- **Contract drift.** Envelope changes affect `shared`, `server`,
  `adapter-utils`, and the run inspector. Follow AGENTS.md §5.2, and run
  `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` for each PR.

## Not in scope

- Changes to native runner (`runtimeMode === "native"`) turn replay beyond the
  shared envelope. The native executor has its own replacement contract
  (`doc/execution-semantics.md`, "native runner session").
- Changes to telemetry (`packages/shared/src/telemetry/`). Every metric in this
  plan uses the run log or the run metadata.

## Implementation status (2026-09-27)

| Phase | Result | Where |
|---|---|---|
| 0. Measurement | Done. `usageJson.sessionStart` records the start kind, handoff size, and continuation sizes. `promptMetrics` records `resumedSession` and `resumeFallback` for each attempt. A full comment-thread read by an agent run writes a `lifecycle` run-log event. | `server/src/services/heartbeat.ts` (`classifySessionStart`), `server/src/routes/issues.ts`, `doc/run-log-events.md` |
| 1. Fallback prompt | Done for claude, codex, gemini, cursor, kimi, opencode, grok, and pi. Each provider attempt builds its own prompt. | adapter `execute.ts` files, `selectPaperclipSessionHandoffNote` |
| 2. Bounded envelope | Done, with changes. See the deviations below. | `packages/adapter-utils/src/continuation-budget.ts`, `execution-continuation.ts`, `renderPaperclipWakePrompt` |
| 3. Structured handoff | Done. `buildSessionHandoffMarkdown` covers rotation and every fresh start that follows prior work. A board `forceFreshSession` gets no handoff. Warm resumes carry `paperclipFallbackHandoffMarkdown`. | `heartbeat.ts` |
| 4. Lean warm resume | Done. Ordinary resume deltas get a compact execution contract. An unchanged objective is replaced by a marker. `omitStartupContextOnResume` is an opt-in and defaults to off. | `server-utils.ts`, gemini/cursor/kimi/opencode adapters |
| 5. Fewer config resets | Narrowed. Only a change to plain env binding values keeps the session. | `resolveTaskSessionConfigFreshness` |
| 6. Skill split | Partial. `SKILL.md` went from 60.3 KB to 54.0 KB. | `skills/paperclip/` |
| 7. Claude/Codex rotation | Not started. This phase waits for the Phase 0 data, as planned. | — |

### Deviations from the plan, with reasons

- **Phase 2: no summary checkpoint.** The issue continuation summary is created automatically from the last run's result. It does not summarize the comment thread, so it cannot "cover" earlier comments. `summaryThroughCommentId` therefore stays `null`. The budget keeps every human-authored message, every origin comment, and the most recent 8 messages. It trims older agent and system bodies to id-only stubs.
- **Phase 2: the budget applies at render time.** The stored envelope in `context_snapshot` keeps the full message bodies. The resume-delta comparison and native continuation need those bodies. A smaller stored copy is a possible follow-up.
- **Phase 4: compact contract, not hash tracking.** Ordinary resume deltas still repeat the disposition check, because missing dispositions are a known failure mode. Assignment, recovery, disposition-repair, and liveness wakes keep the full contract.
- **Phase 4: startup-context skip is opt-in.** The resume behavior of the Gemini, Cursor, Kimi, and OpenCode CLIs was not verified live. An operator enables `omitStartupContextOnResume` for an adapter after verifying it.
- **Phase 5: secrets still reset.** A secret rotation also changes the `adapterConfig` fingerprint. It is a deliberate boundary: a rotated key can belong to a different provider account, and resuming would send the old transcript to that account. There is also no delayed reset for instruction changes. Claude and Codex inject instructions only at session start and do not rotate, so a delayed reset could leave agents on stale instructions indefinitely.
- **Phase 6: headings kept.** The runner capability inventory treats every skill heading as a normative row, and it pins the row count. Each moved section therefore keeps its heading and a pointer. The agent evals were not run, because the eval corpus is in the private `paperclip-evals` repository.

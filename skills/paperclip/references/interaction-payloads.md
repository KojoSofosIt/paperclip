# Interaction and Decision Payloads

Payload recipes moved out of the core Paperclip skill to keep it small. The routing rule and shared interaction semantics in `SKILL.md` (resolver audience, continuation policy, target binding, idempotency, source issue posture) apply to every recipe here.

## Standalone Decisions

Create a decision from an issue-scoped agent run with `POST /api/companies/{companyId}/decisions`:

```json
{
  "title": "Reassign the blocked launch issue?",
  "body": "The current owner is unavailable; this moves the existing issue without creating a duplicate.",
  "ruleKey": "routing.reassign_blocked_issue",
  "options": [
    {
      "id": "reassign",
      "label": "Reassign",
      "effects": [
        { "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }
      ]
    },
    { "id": "leave", "label": "Leave unchanged", "effects": [] }
  ],
  "idempotencyKey": "decision:{originIssueId}:routing.reassign_blocked_issue:v1",
  "continuationPolicy": "wake_origin_agent"
}
```

- `options` accepts 1–8 options; option ids are unique and each option accepts up to 10 effects.
- Supported effects are `comment_on_issue`, `create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree`, and `resolve_blocker`.
- `expiresAt` is optional, defaults to seven days, and must be no more than 30 days away.
- `idempotencyKey` is optional but strongly recommended; reuse is safe only with the same payload.
- `continuationPolicy` is `none` or `wake_origin_agent`. Use the latter only when resolution or expiry must resume the proposer.
- Each origin agent may have at most 50 open decisions by default.

Bundle related cross-issue decisions with `POST /api/companies/{companyId}/decision-bundles`:

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Reassign owner?",
      "body": "Move the issue to the recovery owner.",
      "ruleKey": "routing.reassign",
      "options": [
        { "id": "reassign", "label": "Reassign", "effects": [{ "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }] },
        { "id": "leave", "label": "Leave unchanged", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:routing.reassign:v1"
    },
    {
      "title": "Clear obsolete blocker?",
      "body": "Remove the resolved dependency from the blocked issue.",
      "ruleKey": "blockers.clear_obsolete",
      "options": [
        { "id": "clear", "label": "Clear blocker", "effects": [{ "type": "resolve_blocker", "targetIssueId": "{issueId}", "staleness": "strict", "removeBlockedByIssueIds": ["{blockerIssueId}"] }] },
        { "id": "keep", "label": "Keep blocker", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:blockers.clear_obsolete:v1"
    }
  ]
}
```

Bundles accept 1–50 decisions and are created atomically. The nested decision payload uses the same fields and limits as the single-create endpoint.

Create a `request_checkbox_confirmation` (the responder selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

When it is accepted, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## Item Verdicts

Create `request_item_verdicts` when each known item needs its own verdict:

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

The responder submits verdicts with `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts`. Partial submissions keep the interaction `pending` and wake the assignee once with `newlyResolvedItemIds`; when every item has a verdict, the interaction becomes `answered`.

---
kind: upgrade-guide
description: "The operation authority refuses requests until the witness confirms a record of its changed configuration, its grant settings carry that record's receipt, and its database moves to schema version 13."
---

# Operation authority records its configuration with the witness

English | [中文](guide.zh.md)

## Change

At a start whose configuration differs from the one its database last recorded, `@deepseek-ai/dsh-operation-control` sends the witness a `configuration` event and refuses every request with `configuration-evidence-unavailable` until the witness confirms it. Previously the start replaced the grant revision without any witness event. A configuration record that the witness refuses, such as one larger than 64 KiB, fails the start with `configuration-evidence-refused`.

The configuration fingerprint now covers the recorded configuration, so the first start after the upgrade replaces the grant revision once: approvals and permits that were not yet consumed no longer apply, as after any configuration change. The database opens at schema version 13; earlier versions of the package cannot open it afterwards.

`OperationControlClient.grant()` and `updateGrant()` responses, and `HandoffControl.grantSettings()`, contain a required `configuration` receipt (`id`, `digest`). `verifyRecords(approver, evidence)` also calls `approver.grant()`, so `approver` needs `grant` as well as `receipts`, and the result can report the problem `event-missing`.

## Migration

1. Start the witness before the authority, or start it soon after: until it confirms the record, the authority serves no request.
2. Resolve pending approvals before upgrading, or approve them again afterwards.
3. In code that builds `OperationGrantBudget` values or passes a custom `approver` to `verifyRecords`, add the `configuration` receipt and a `grant` method.
4. Confirm with `pnpm vardock verify`: it compares the current configuration record and reports no `event-missing` problem.

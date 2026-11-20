---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-assistant-work

English | [中文](2026-11-09-assistant-work.zh.md)

## Summary

Adds the assistant-work message source for durable delegation requests and result notices. It records a work identity, request/result direction, notice form, and summary in existing inbox and message events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-assistant-work
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "0ee879606d0d2d349db16c2084aff076561e9df87b492bc140e5724817fcfe46"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "09ea8e01021d15f6def5b010f07b65b84907519ed46a6c06cfc48e229fe2171c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "dba7890955f7da01ea6c22aced7c49332dd7be1c30d1d224410ca5b5f8d009c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "42c291d9b472a37338b74ef529e780ff036476ec273d607079a754cabb0a79fa"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages remain valid. The new producer uses the distinct kind assistant-work and the existing notice form. Session readers already accept nonempty producer kinds on user/developer messages and preserve their content and source fields; consumers without this plugin treat these records as ordinary notices. Current readers also accept earlier sources unchanged. No event discriminator or Session header interpretation changes, so the writer version is unchanged. Result intake receipts are reconstructed by the assistant projection; removing the plugin does not replay commands. The separate assistant storage domain starts at version 1 and does not alter released Session generations.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/assistant/tests/assistant.spec.ts: 10 tests passed with real JSONL persistence, storage-domain, SessionController, checkpoint policy, and Loader. Tests cover independent workers, duplicate keys, restart recovery, saved result admission, cancellation, dispatch failures, and concurrency staging. Existing Agent tests exercise unknown producer sources.

<a id="dev-note"></a>
## Dev Note

None.

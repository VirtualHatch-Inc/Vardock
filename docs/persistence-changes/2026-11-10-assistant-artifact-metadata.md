---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-assistant-artifact-metadata

English | [中文](2026-11-10-assistant-artifact-metadata.zh.md)

## Summary

Adds optional witnessed artifact metadata to Assistant work result sources.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-assistant-artifact-metadata
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-assistant-work"
    after: "b1f151378a4731df7f9d5ed6a7163740b733ed5d93030ab97bdff0aed468a7a1"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-assistant-work"
    after: "f84dfb959a351eaa0f165f2cbc13f33a4bc7313f2602f8fd99f586e5281df710"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-assistant-work"
    after: "19d6bba3c41cd6c82cc58ef577ac339e384f9267ecb8865eb63f900feadd81f2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-assistant-work"
    after: "89df9ae8fe2e79f2c14ba379589754e5504ba5758ee19f2b22321daf488aef65"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid because the field is optional. Older readers ignore artifact metadata and retain the existing result notice; newer readers show downloads only when metadata is present. Metadata contains names, byte counts and content digests, never bytes or a Host path. The owner-only download rechecks the authority release and current work permissions. Replay renders the existing notice without repeating export.

<a id="verification"></a>
## Verification

Assistant focused data, coordinator and mediation tests passed 46 cases; the artifact component and launcher tests passed 6 cases. The Apple VM binary transfer smoke passed with exact import and export bytes and symlink refusal.

<a id="dev-note"></a>
## Dev Note

None.

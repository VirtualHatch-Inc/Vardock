---
kind: upgrade-guide
description: "Fresh Assistant work must state its permissions, and the authority's `assistant.permissions.data` requires `returnResponses`, which now decides whether business response text reaches work scripts."
---

# Assistant work states its permissions and response access

English | [中文](guide.zh.md)

## Change

Before, a delegation that omitted `permissions` received the whole `assistant.permissions` ceiling of the [operation authority](../../../../packages/experimental/operation-control/README.md). Now the authority refuses fresh work without permissions with `work-permission-required`; a continuation without permissions keeps its predecessor's grant. The `delegate_work` tool describes `permissions` as required for new work.

Fresh `delegate_work` calls in a turn triggered by an owner request with attachments must also state `inputs`: attachment coordinates, or `[]` when the work needs no files. Omission now fails with `work-file-denied` before a grant or worker is created; the error names each attachment and its selection value. Requests without attachments and continuations keep their existing omission behaviour. Selected inputs still require import and both disclosure permissions.

Before, an action configured with `returnResponse: true` returned its response text to every work script that requested it. Now the text is returned only when both the ceiling and the work grant allow the new data permission `returnResponses`; otherwise the request is still sent and recorded, and the reply carries `bodyOmitted: "not-permitted"`. The authority's `Config` requires `returnResponses` whenever `assistant.permissions.data` is present, so a profile without it fails to load. Work grants recorded before this change have no `returnResponses` and withhold response text; their requests are otherwise unchanged.

This affects authority profiles written by `vardock setup` or by hand, and Host code that calls `HandoffControl.release` for fresh delegations without `delegation.permissions`.

## Migration

1. Stop Vardock.
2. In the authority profile's `operation-control` row, add `returnResponses` to `assistant.permissions.data`: `true` to let work that is granted it receive response text, `false` to withhold it from all work. `vardock setup` now writes `true`.
3. In Host code, pass `delegation.permissions` for every fresh delegation. For `delegate_work` or `AssistantRuntime.delegate` in an attachment-triggered entrance turn, also pass selected `inputs` or an explicit empty list.
4. To give existing work response text, delegate fresh work with `data.returnResponses: true`; a continuation cannot gain it.
5. Start Vardock and confirm the authority loads, then delegate work that calls an action with `returnResponse: true` and check that its script receives `body` only when the work grant allows `returnResponses`.

---
kind: upgrade-guide
description: "Owner Remote calls must supply valid access resources."
---

# Validate resources in owner Remote calls

English | [中文](guide.zh.md)

## Change

The Gateway resolves resources for owner calls as well as non-owner calls. An invalid resource now returns `remote-access/denied` with `details.reason` set to `resource-invalid` for either caller. This affects Remote callers that supplied malformed resource identities and plugin methods whose resource readers fail on owner inputs.

## Migration

1. Supply non-empty string identities for resources named by your request. For custom Remote methods, check the [`@Remote` and `@RemoteScope` resource readers](../../../api-gateway.md#programming-model) and any lookup, Context, or default resource declaration used by the method.
2. Repeat the owner call with a valid identity and confirm the method receives it. If a malformed request is intentional, handle `remote-access/denied` with reason `resource-invalid`.

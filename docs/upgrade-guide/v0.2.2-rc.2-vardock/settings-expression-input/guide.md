---
kind: upgrade-guide
description: "Settings form writes refuse configuration expressions."
---

# Write configuration expressions only in the profile patch

English | [中文](guide.zh.md)

## Change

`settings.update`, `settings.replace` and `settings.mutate` accepted an object with a `__jsExpr` key as a form value, stored it as a `!!js` expression in the profile patch, and the Loader evaluated it in the Host process. These writes now return `settings/rejected` when a value contains a `__jsExpr` key or a `mutate` path names one. This affects Remote and SDK callers that set expressions through settings writes; shipped clients do not send them.

## Migration

1. Write the `!!js` expression directly in the active profile's `cordis.patch.yml`, then restart or let hot reload apply it.
2. Confirm the plugin's Settings form shows the evaluated value.

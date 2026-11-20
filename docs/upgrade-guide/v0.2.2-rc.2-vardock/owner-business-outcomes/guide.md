---
kind: upgrade-guide
description: "Business completion can carry an owner determination without an external receipt ID, and the authority database advances to schema version 13."
---

# Owner determinations of business outcomes

English | [中文](guide.zh.md)

## Change

`businessCompletion` in business status and Business records can now contain `{ kind: "succeeded" | "failed", source: "owner", receipt }`. This is an owner-checked outcome witnessed through the existing reconciliation record, without an external `receiptId`. Lookup results retain their existing fields. Clients that require `receiptId` for every terminal completion must handle the owner form.

The Business records page gains **I checked: it happened** and **I checked: it did not happen**. The privileged `POST /resolve-business` request accepts `{ id, kind }`, where `kind` is `succeeded` or `failed`. No model or worker tool exposes it. The determination takes effect only after witness confirmation.

The authority database advances to schema version 13 without rewriting earlier records. Older authority versions cannot reopen it.

## Migration

1. Upgrade the authority and Assistant Host together. Preserve the authority and witness databases before upgrading; do not replace them to clear unresolved operations.
2. In custom clients, distinguish `source: "owner"` from a lookup result before reading `receiptId`; use `receipt` for the witness acknowledgment in both cases.
3. After checking an unresolved external operation, choose the matching action on **Business records**. Confirm the row names the owner and `pnpm vardock verify` reports no mismatches. If the determination is unconfirmed, read current records and check the authority and witness before trying again.

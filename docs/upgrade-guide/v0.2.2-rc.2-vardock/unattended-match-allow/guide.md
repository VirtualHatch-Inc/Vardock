---
kind: upgrade-guide
description: "Unattended rules with match now require allow to name the other permitted request fields."
---

# Matching unattended rules require an allow list

English | [中文](guide.zh.md)

## Change

An `operation-control` profile rule in `unattendedBrokerActions` that has `match` must also have `allow`. Previously, omitting `allow` left every other field unchecked. Now the authority refuses to load that profile. For action `capture`, the load error includes this exact diagnostic:

```text
Unattended rule for action "capture" must add allow (use allow: [] to permit no other fields).
```

Rules without `match` still accept the same fields. The Connections editor saves `allow: []` when conditions are present and the other-fields input is blank. The authority checks the names of fields in `allow`, but not their values.

A development database holding a saved owner rule with `match` but no `allow` fails to load with `storage-unavailable` and the cause `The saved unattended rules are corrupt`. No migration rewrites these witnessed records.

Requests to an action now wait for owner approval while an earlier request to that action has an unresolved outcome, even when the body differs. Previously, only an exact body repeat waited. The approval card names the earlier operation.

## Migration

1. Stop Vardock. In the authority profile's `cordis.patch.yml`, find the `operation-control` row and every `unattendedBrokerActions` rule with `match`.
2. Add `allow: []` to permit only the fields in `match`, or list each other permitted top-level field. For example, `{ action: capture, match: { account: A1 }, allow: [amount] }` permits `account: A1` and an optional `amount` field, with no other fields.
3. For a disposable development database with the saved-rule error, stop both services and preserve the authority and witness databases, then configure fresh `databasePath` values for both services and recreate the rules. Do not discard records of unresolved operations or edit witnessed records to bypass the failure.
4. Start Vardock and confirm the authority loads. In Connections, confirm an empty list says no other fields are permitted, and a nonempty list names the permitted fields.
5. Inspect unresolved operations before sending more requests to the same action. Use a configured outcome lookup to confirm the earlier result; changing JSON field order or allowed values no longer avoids owner approval.

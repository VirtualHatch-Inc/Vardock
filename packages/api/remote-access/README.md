---
description: "Remote access control with endpoint guards, role-based policies, list filtering, and per-Peer grant snapshots."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-access

English | [中文](README.zh.md)

## Summary

Business packages can guard Remote calls and list items for any principal, including the owner. Role policies also govern non-owner calls and forwarded events. The [API Gateway](../gateway/README.md) checks call resources after JSON validation and before lookup resolution. List methods filter items through `allows()`. Each Client follows its Peer’s grant snapshot to hide entries outside those grants. The [Peer principals Agent Note](../../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) describes the design.

## Table of Contents

- [Host service: `RemoteAccessService` (ctx key: `remoteAccess`)](#host-service)
- [Client face](#client-face)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="host-service"></a>
## Host service: `RemoteAccessService` (ctx key: `remoteAccess`)

Every composition that mounts [API Gateway](../gateway/README.md) mounts this service: the Gateway injects `remoteAccess` and does not start without it. [`bundle/base`](../../bundle/base/cordis.patch.yml) loads it beside `typert-gateway`.

| Member | Contract |
|---|---|
| `guard(callback)` | Registers a synchronous check in the caller’s fiber and returns its disposer. The callback receives the same request as `decide()` for calls and a single resource without `args` for list items. It returns a public refusal reason or `undefined` to continue. |
| `registerPolicy(kind, policy)` | Registers the `RemoteAccessPolicy` of one non-owner principal kind; its `bindings()` and `explain()` receive principals typed by that kind. A second policy for the same kind throws. The registration is a Cordis effect of the caller's fiber; registration and removal recompute open snapshots. |
| `invalidate(principal?)` | Reports that bindings or condition answers for one principal, or for every principal, may have changed. A business package calls it on every grant, revocation, mode change, and expiry. |
| `decide(request)` | Gateway-only. `request` is `{ principal, action, resources, args? }`: the caller or recipient, the endpoint `ns/method` or `event:<name>`, the valid resources the Gateway resolved, and a call's arguments validated against their Typert-compiled types, with lookup parameters as wire identities. Returns `{ kind: 'allow' }` or `{ kind: 'deny', reason }`; the Gateway throws `remote-access/denied` with details `{ action, reason }` for a denied call and drops a denied event without building an error. The first endpoint guard to refuse decides the result. The owner and `remoteAccess/follow` then qualify without policy bindings. |
| `allows(resource)` | Reads the invocation of the Context that accessed the service, so a list method calls `this.ctx.remoteAccess.allows(resource)` for each item. Checks guards and non-owner policy bindings on that resource without arguments. Returns true outside a Remote call. |
| `snapshotFor(principal)` | The baseline a page opens with: `{ type: 'baseline', owner: true }` for the owner, otherwise the principal's current grants. |
| `follow(signal)` | Remote stream `remoteAccess/follow`: one `baseline`, then `upsert` and `remove` frames. The owner receives only `{ type: 'baseline', owner: true }`. The stream ends when `signal` aborts or the service unloads, so a reloaded service starts every reader from a fresh baseline. |

A role `{ name, resource, actions }` is a plain value naming an action set over one resource kind, `global` or a kind declared in `TypertResourceMap`. A binding `{ role, resource, condition? }` grants the role on one resource of the role's kind. A policy answers `bindings(principal)` and an optional `explain(request)` synchronously from state it holds in memory. A policy grants a request only when, on every resolved resource, some binding names that resource, its role lists the action, and it has no condition or its condition allows. Resources are independent: a grant on `global` implies nothing on any other resource, and no resource implies another. A condition receives `{ action, resource, args? }` and runs only for a binding whose resource and role match; `args` is absent for events, snapshots, and list filtering. `bindings()` runs once per policy check and once per snapshot computation. The service reads current bindings on every check.

The Gateway resolves resources from `@Remote` and `@RemoteScope` `resources` readers, lookup and Host Context adapter `resource` declarations, and the default field or resolver declarations in `typert.resources`, and the [API Gateway](../gateway/README.md) owns that order; this package reads no argument field. A call that names no resource touches the `global` resource alone, so only a `global` role can allow it; putting an action in a `global` role lets the principal call it on any resource the call does not name. The Gateway refuses a call whose resources are invalid with `resource-invalid` without asking `decide()`.

Policy authors must treat `session/attachment` as access to the entire attachment store: granting that action on any one Session resource lets the caller supply that `sessionId` and read images referenced by other Sessions or by none. Gateway still checks that Session resource, but the handler checks neither Session existence nor image membership. Use separate Host instances with separate `DSH_HOME` directories when readers require separate image stores; see the [image access rule](../../../.agents/notes/implemented/architecture/2026-10-23-store-scoped-image-reads.md).

When `bindings()`, a condition, or `explain()` throws, the decision is refused with `policy-failed`; in a snapshot, a throwing `bindings()` leaves the principal no grant and a throwing condition excludes its action. A faulty rule therefore never breaks the shared `$events` source, the snapshot stream, or page rendering. The service logger reports the first failure of each policy after each `invalidate()` and each policy registration or removal; later failures of that policy stay silent until then.

A forwarded event is decided as the action `event:<name>` on the resources its forwarding entry's readers name, or on `global` when the entry declares none, and reaches a non-owner whole or not at all; its payload is never trimmed. An event carries every resource it declares, so a reader that returns `undefined` makes the event's resources invalid, and the Gateway delivers it to no non-owner without asking `decide()`. An event names at most one resource, so collection changes travel on follow streams (`session/follow`, `session/control`, `workspace/follow`), whose methods decide each item inline through `allows()`.

The service adds a `global` row named `REMOTE_ACCESS_SNAPSHOT_KEY` (`__DSH_REMOTE_ACCESS__`) holding `snapshotFor(peer.principal)` to every index the webServer renders through `webserver/index-inject`, for the Peer that render speaks for: the owner's browser page opens with `{ type: 'baseline', owner: true }`, and a page rendered for a non-owner Peer, such as a liveshare viewer page rendered on the owner Host, opens with that viewer's grants. The Client entry reads the global when it mounts.

| `details.reason` of `remote-access/denied` | Cause |
|---|---|
| `resource-invalid` | Given by the Gateway before `decide()`: a resource reader threw or returned an empty list, or a resource id, including a Context identity, is not a non-empty string. |
| `no-allow` | The principal kind has no policy, or no binding allows the action on some resource and neither a condition nor `explain()` names a reason. |
| Guard reason | The first registered guard that refuses the endpoint check provides the reason. |
| `guard-failed` | A guard threw. The service logs the first failure of each registration and refuses the affected call or item. |
| `policy-failed` | `bindings()`, a condition, or `explain()` threw; the failure is logged as described above. |
| condition or `explain()` reason | On the first resource no binding allows, the first refusing condition of a matching binding names the reason; without one, `explain(request)` does. |

Snapshot grants list the sorted endpoint actions granted by the principal’s policy bindings for each resource without call arguments. The stream pushes `remove` when a resource loses its last granted action. Snapshots track policy grants, while endpoint guards apply to live calls and list items. Snapshots are recomputed only after `invalidate()` and policy registration or removal.

<a id="client-face"></a>
## Client face

The Client entry reads the baseline the index injected under `REMOTE_ACCESS_SNAPSHOT_KEY` synchronously, mounts the generated `remoteAccess` contribution itself through `mountAccess(ctx, contribution, initial)`, follows the snapshot stream, and provides:

- the Client service `ctx.remoteAccess.source(kind, id, action)`, an identity-stable boolean source per `(kind, id, action)` for one resource of a declared kind;
- `ctx.remoteAccess.whenAccess(action, callback)`, which keeps the callback's effects installed while the `global` resource allows `action`: the callback runs when the answer becomes true, its effects dispose in reverse order when it becomes false, and it runs again on the next true. The callback returns one disposer or an iterable of disposers, as with `ctx.slots.inject`; it runs synchronously when the answer is already true, as it always is for the owner; the controller belongs to the caller's fiber. A setup failure while allowed throws at once; a later one retires the controller and is rethrown in a microtask. `whenResourceAccess(kind, id, action, callback)` is the same for one resource of a declared kind;
- the standard Hook `useRemoteAccess(action)`, which answers on the `global` resource.

Domain UI packages publish their resource Hooks over `source()` and their `whenAccess` over `whenResourceAccess()`: [ui-session](../../client/ui-session/README.md) provides `useSessionAccess(sessionId, action)`, the Session-scope `useAccess(action)`, and `ctx.uiSession.whenAccess(sessionId, action, callback)` on Session resources, a different name from the `global` `useRemoteAccess`, and [ui-workspace](../../client/ui-workspace/README.md) provides `useWorkspaceAccess(workspaceId, action)` and `ctx.uiWorkspace.whenAccess(workspaceId, action, callback)` on Workspace resources. Only the package that owns a resource kind calls `source()` and `whenResourceAccess()`; other plugins read access through the access Hooks and the `whenAccess` methods. A Hook's `action` is a `RemoteEndpoint`, an endpoint some Client Remote namespace declares. A non-owner answer is whether that resource's grant lists the action and never falls back to the `global` answer, so a resource without a grant, or whose grant lists no action, answers false. Every answer is true for the owner; a non-owner page without an injected baseline, and a non-owner page whose stream fails terminally, answers false; the terminal failure is reported with its error, for a non-owner with the advice to reload the page and for the owner with the note that its answers are unaffected; a reconnect keeps the last snapshot. A malformed injected baseline fails the mount. Hooks never issue requests, and the Host still checks every call. [`dsh-client-test-runtime`](../../test-support/client-runtime/README.md) replaces this row with fixed answers, allow-all by default, in Client specs.

<a id="model-experience"></a>
## Model Experience

None, as this package decides Remote access for Client callers and registers nothing model-facing.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Snapshot and list-filtering decisions carry no call arguments, so a condition that refines its answer from `args` can refuse a call that the snapshot shows as allowed.
- Resource readers and automatic resolution must cover every resource a method touches; a resource the call does not name is not checked, so a principal granted on the named resources reaches it.
- Default resource resolution matches wire field names; adding a field with a registered kind's name to a method adds that kind's resource to the call.
- Exact Connection Fetch routes do not pass through the Gateway; the shared Fetch handler refuses them to every non-owner Peer with 403 until each route declares its own access rule.
- Interaction participation (answering forwarded waterfalls) is owner-only: non-owner `$events` streams receive only the broadcast frames whose `event:<name>` action the policy allows on the event's resources.
- `api-session/added` carries the whole `SessionSummary`, so a non-owner allowed to receive it also learns its `parentSessionId`.
- A granted Session's cwd and tool paths already contain the owner's absolute paths, so the `$events` ready frame gives a non-owner the full `host`, including `home`; the Gateway does not hide `home` separately.
- `workspace/follow` notices a Workspace whose visibility a policy revoked only when that Workspace or the Workspace order next changes, and then replaces the non-owner's baseline; an access change alone sends no frame.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

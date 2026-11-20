---
description: "Authorize isolated shell, file transfer, model, and HTTPS JSON operations under a shared grant with a separate witness process."
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-control

English | [中文](README.zh.md)

## Summary

Give an Agent Host one budget for isolated shell operations, scoped file transfers, optional model requests, and optional HTTPS JSON operations. Vardock setup runs scripts automatically with `unattendedShell: true`; broker requests wait for the owner unless a fixed owner rule admits them. The authority evaluates these rules, never a model. Notes and schedules retain their approval. Each permit requires a durable reservation and a receipt from a separate witness process. Query an operation by ID after a lost response.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Run the Agent Host, operation authority, and evidence witness under three distinct OS accounts. Use operator-owned builds, profiles, and parent directories outside the Agent Host's write access. Mount an [isolated execution provider](../execution-container/README.md) in the authority profile with a trusted preloaded image. Give the Agent Host the operation socket. Restrict witness socket access to the authority account.

Create an authority-owned SQLite directory with mode `0700`. Create a separate authority-owned Unix socket directory with mode `2750` and the dedicated Agent Host group. This gives that group directory traversal and inherits its group on the socket. The authority sets the socket to `0660`. Place the socket directory under a parent that the Agent Host cannot replace.

Give the approval socket a directory restricted to the trusted approval Host. Grant its group access only to processes trusted to submit human decisions and change grant limits. In a single-account development setup, processes running under that account can reach both sockets.

### Minimal configuration

Create `$DSH_HOME/profiles/operation-authority/package.json` under the authority account. Install the listed packages into this profile using the same version as the running Harness.

```json
{
  "name": "operation-authority-profile",
  "private": true,
  "dsh": { "profile": { "bundles": [] } },
  "dependencies": {
    "@deepseek-ai/dsh-execution-container": "0.2.2-rc.1",
    "@deepseek-ai/dsh-operation-control": "0.2.2-rc.1",
    "@deepseek-ai/dsh-subprocess-local": "0.2.2-rc.1"
  }
}
```

Create `cordis.patch.yml` beside that manifest. This example uses an authority-owned rootless Docker daemon. Set the grant expiry to the intended UTC epoch time in milliseconds. Replace the example paths and the image with the ones provisioned by the operator.

```yaml
- insert:
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: isolated-execution
      name: '@deepseek-ai/dsh-execution-container'
      config:
        backend: docker
        dockerSocket: /run/user/1001/docker.sock
        image: dsh-execution:local
    - id: operation-control
      name: '@deepseek-ai/dsh-operation-control'
      config:
        principalId: agent-host
        scopeId: offline-shell
        socketPath: /run/dsh-authority/operation.sock
        approvalSocketPath: /run/dsh-approval/decision.sock
        databasePath: /var/lib/dsh-authority/operation.sqlite
        evidenceSocketPath: /run/dsh-witness/evidence.sock
        grantExpiresAt: 1798761600000
        maxOperations: 20
        assistant:
          mainSessionId: assistant-main
          permissions:
            exec: true
            brokerActions: []
```

Start the [witness profile](../operation-evidence/README.md) first, then run `dsh --profile operation-authority` under the authority account. Set `DSH_OPERATION_SOCKET` on the Assistant profile to the operation socket and `DSH_APPROVAL_SOCKET` to the approval socket.

| Field | Default | Meaning |
|---|---|---|
| `principalId` | required | Operator-assigned principal for callers with socket access. |
| `scopeId` | required | Operator-assigned namespace for isolated workspaces. |
| `socketPath` | required | Unix socket for authorized Agent Hosts. |
| `approvalSocketPath` | required with `assistant` or `broker` | Separate Unix socket for approval decisions and owner grant settings. |
| `databasePath` | required | Authority-owned SQLite file on a local filesystem. |
| `evidenceSocketPath` | required | Separate witness socket. Each start with a changed configuration waits for the witness to confirm its record. |
| `grantExpiresAt` | required | Initial UTC expiry in epoch milliseconds. |
| `maxOperations` | required | Initial lifetime reservation cap for the database. |
| `maxFileBytes` | `8388608` (8 MiB) | Maximum decoded bytes per imported file or exported snapshot. The highest setting is 32 MiB. |
| `requestTimeoutMs` | `10000` | Time allowed to send the request. |
| `evidenceTimeoutMs` | `5000` | Time allowed for a witness acknowledgment. |
| `model.provider`, `model.model` | omitted | Allow one provider route and model ID on the same budget. The authority profile must mount the LLM adapter that registers the route. |
| `model.credentialRef` | omitted | Credential reference that adapter reads its API key from. Setting it lets the owner store the key from the Assistant. |
| `assistant.mainSessionId` | omitted | Allow delegation from this entrance and delivery to the same entrance. Omit to refuse both operation kinds. |
| `assistant.permissions` | required with `assistant` | Root permission ceiling for `exec`, the exact `brokerActions` allowlist, and optional file permissions. |
| `assistant.permissions.data` | omitted | `import` and `export` allow each direction when both `discloseToModel` and `discloseToUser` are enabled. `returnResponses` allows business response text to be returned to work scripts. All five fields are required when `data` is present. Omission denies transfers and returned responses. |
| `broker` | `[]` | Service names of the mounted broker providers, for example `['operationBroker', 'operationBrokerMcp']`. A non-empty list allows a running shell operation to request a configured action. The authority selects the provider that lists the requested action and refuses to start when two providers list the same action. |
| `unattendedShell` | `false` | Admit shell proposals without a human decision; business requests wait unless an owner rule admits them. Vardock setup writes `true`; `--review-scripts` writes `false`. Requires an execution backend that supports business requests: Apple VM without CONNECT targets, or Docker with `gatewaySocket`. Changing it invalidates unconsumed approvals and permits. |
| `unattendedBrokerActions` | `[]` | Rules that send a matching business request without a human decision. Each rule names an `action` from `assistant.permissions.brokerActions`, optional `match` values for top-level body fields, and `allow`, up to 64 names of other top-level fields the body may contain. A rule with `match` requires `allow`; use `allow: []` to permit no other fields. A rule with `match` or `allow` covers only a JSON object body in compact `JSON.stringify` form. The values of fields named in `allow` are not checked. With neither `match` nor `allow`, a rule covers every body of its action. An action takes at most 64 rules. These rules apply until the owner's first witnessed rule edit; from then on the owner's rules replace them, also after a restart or a profile edit. No rule admits a [repeat of a request whose outcome is unresolved](#repeated-business-requests). [Edit unattended rules](#edit-unattended-rules) |

Query an operation through `OperationControlClient.status(id)` or send `POST /status` with JSON `{"id":"<operation UUID>"}` over the operation socket. Querying retries pending witness receipts. To recover a lost proposal response, submit the same request key and payload. Inspect `unknown` outcomes before deciding whether to request new work.

For a read-only summary, the Host calls `HandoffControl.overview` for its entrance or worker Session. A work ID narrows the counts to one assignment while the budget still covers all reservations in the database. The summary remains readable after grant expiry. It omits operation payloads and reports operations awaiting outcome evidence as uncertain. Its `disclosesImportedData` is `false` while the Session may retain imported owner files and the current ceiling, the Session's current work grant, or the named assignment's grant lacks either disclosure permission; the Assistant reads it before it shows a work report to the entrance model.

The overview clears its last-issue notice after a newer operation succeeds. Earlier unknown outcomes remain counted and retain their records; a successful later request does not resolve them.

### Configuration changes are witnessed at start

At each start, the authority compares the fingerprint of its configuration with the one its database last recorded. When they differ, including at the first start of a new database, it sends the witness one `configuration` event before it serves a request. The event names the principal and scope, the previous and the new grant revision (`previousRevision` is `null` for a new database), and a `configuration` object: the `assistant.permissions` ceiling with `mainSessionId`; the combined broker fingerprint and, for each permitted action, its ID, credential reference name, and whether its response is returned; `unattendedShell`; the profile's `unattendedBrokerActions`; the model provider, model ID, and credential reference name; the execution backend fingerprint; and the profile's `grantExpiresAt`, `maxOperations`, and `maxFileBytes`. It contains no credential value, socket path, or endpoint. The event ID is a digest of the event content, so a start with the same stored state and configuration repeats the same event and the witness returns its existing receipt.

The authority stores the receipt and adopts the new revision in one transaction; a start whose fingerprint the database already recorded sends nothing. Until the witness confirms the event, the authority listens but refuses every request on both sockets with `configuration-evidence-unavailable`, and each request retries the same event, so the authority recovers without a restart once the witness is reachable. If the witness refuses the event, for example because it exceeds the 64 KiB request limit of the authority's witness client, the start fails with `configuration-evidence-refused`; permit fewer broker actions or shorten the unattended rules. A database created by an earlier version records its configuration at its first start with this version; it keeps its revision only when the fingerprint is unchanged. `HandoffControl.grantSettings` returns the receipt as `configuration`.

When admission or configuration awaits the witness, the owner notice names the witness service, says that the request did not run or send anything, and directs Vardock owners to `pnpm vardock doctor`. The authority recovers when the witness returns; an already executed operation with missing outcome evidence remains uncertain.

The witness holds the configuration in effect from each start. It does not hold the profile file, a profile edit reverted before the next start, or settings outside this plugin's configuration, such as other plugins in the authority profile and the Host and Web profiles.

### Edit the grant limits

The authenticated owner can change the lifetime reservation cap and expiry from the Assistant. The Host's handoff provider uses its `approvalSocketPath` for `HandoffControl.grantSettings` and `HandoffControl.updateGrant`. The update includes the revision returned by the read. On a stale revision, refresh the settings before deciding whether to save again.

The authority applies a change after verifying a receipt from the witness. It stores the two limits in the authority database and uses them on restart. Every prior reservation still counts, and lowering the cap below the reserved count leaves zero slots. An expiry in the past prevents new admissions. If the witness is unavailable, the previous limits stay in effect. If the reply is lost, reload the settings to confirm the result.

An effective edit invalidates existing unconsumed approvals and permits. An approval card that was already open can still be dismissed. The authority rejects a stale approval, and the overview excludes it from the pending count. Business inspection retains the recorded state and reports `revision-mismatch` until cancellation. If a business review fails because its revision changed, the broker request is canceled and the parent script can continue. Consumed operations keep their recorded state and can retain their outcomes. Previously witnessed work assignments keep their own permissions and use the current limits when reserving new operations. An unknown outcome stays queryable under its original operation ID.

### Set connection credentials

The authenticated owner can store the bearer token of a permitted broker action, and the API key named by `model.credentialRef`, from the Assistant. The Host's handoff provider uses its `approvalSocketPath` for `HandoffControl.brokerConnections` and `HandoffControl.setBrokerConnection`. The list contains each permitted action, its usage text, its credential reference, whether a value is stored, whether its response is returned, and the unattended rules that cover it. It also reports `unattendedShell` and, when `model.credentialRef` is set, the model route with its credential state. No read returns a value.

The authority writes the token to its own credential provider under the action's credential reference. It refuses an action outside the Assistant grant and text that is not a bearer token. The Host forwards the value without retaining it. The authority handles credential changes one at a time in arrival order. Before each write or removal, it sends the witness an event that names the action or the model route and whether a value is stored, without the value; it refuses the change when the witness does not confirm it. The event records the owner's accepted change request before the write, not the result of the write: if the write then fails, the request returns an error and the witness still holds the event. The change does not alter the grant revision. The broker resolves the credential for each request, so the next request uses the new value.

<a id="edit-unattended-rules"></a>
### Edit unattended rules

The owner can replace the unattended rules of one permitted action with `HandoffControl.setBrokerConnection({ action, unattended, revision })`. Each rule takes the `match` and `allow` fields of `unattendedBrokerActions`; `allow` is required with `match`. In the Connections editor, blank other fields with conditions saves `allow: []`. `revision` is the value returned by `brokerConnections`; the authority refuses a stale one with `revision-mismatch`, an action outside the Assistant grant with `broker-action-unavailable`, and an edit while another limit or rule edit awaits the witness with `grant-update-in-progress`. The authority saves each action's rules with the action's current route digest, which its broker provider derives from where a request for the action goes and what comes back. [Route digest](../operation-broker/README.md#understand-the-implementation) The authority applies an edit after the witness confirms an `unattended-rules-update` event that carries every saved action with its route digest and rules, and the revision it replaces; if the witness does not confirm it, the previous rules stay in effect. The authority saves the rules in its database separately from the grant limits, so a rule edit does not fix the limits and a limit edit does not change the rules.

Only the owner's rules apply from the first edit on; a profile edit, including one of `unattendedBrokerActions`, does not change them. The first edit also saves the profile's rules of each other permitted action that has any, each under that action's current route digest. Every edit replaces only the edited action's entry. It keeps every other saved entry with its route digest, including one whose rules are off, and drops the entries of actions the grant no longer permits. An empty list is saved as such: every request of that action waits for a decision. An action's saved rules apply exactly while its current route digest equals the saved one. Otherwise no request of that action is sent without a decision, `brokerConnections` reports `routeChangedSinceRulesSaved: true` for that action and lists no rules for it, and other actions keep their rules. The saved rules stay in the database and apply again when the operator restores the route they were saved under. The next edit of that action saves a new list under its current route digest, starting from no rules.

An edit changes the grant revision. A changed route changes its provider's fingerprint and therefore the authority fingerprint, which replaces the grant revision at start. Either way, approvals and permits not yet consumed no longer apply. An agent cannot reach this request: it is served on the approval socket only.

### Bind work to its principal and permissions

The trusted Host socket represents the configured `principalId`. The Assistant accepts interactive mutations from DSH's authenticated owner and delegates only through its configured entrance. Neither a prompt nor a tool argument supplies the principal. Use separate Host and authority compositions for different owners; a shared entrance does not provide multi-user isolation.

Set `assistant.permissions` explicitly. `exec` allows scripts inside the worker's own Session VM; `brokerActions` lists the external actions that work may request. An empty list allows no business dispatch and needs no broker. Every listed action must be provided by a configured broker; otherwise startup names the missing actions and tells you to add their routes or remove them from the permissions. Adding a broker route does not add it to this permission list. The existing model setting remains the only available model route.

A witnessed delegation binds the work ID, principal, worker Session, previous work, and resolved permissions. Requested permissions must fit inside the root ceiling; continuing a worker must also fit inside its preceding work grant. Fresh work must state its permissions; the authority refuses one that omits them with `work-permission-required`. A continuation that omits them keeps its predecessor's grant, narrowed by any later reduction of the root ceiling. A later increase to the root ceiling does not widen an existing work grant. The worker's VM workspace remains bound to its Session; continuation retains that workspace, while a fresh worker receives its own.

The authority checks the current work and permission ceiling before admission, human approval, and execution. An approval cannot add a capability or a broker action. A continuation supersedes the preceding work for that Session, so an earlier unconsumed permit cannot execute under the successor's grant. Historical results remain recorded. Work from before explicit grants remains inspectable but cannot acquire permissions by inference; submit a fresh scoped request.

### Transfer work files

Use an isolated execution provider that supports file transfers. For each transfer, the authority requires the direction and both disclosure permissions in the current root ceiling and the work grant. Both disclosure permissions are required because the model can receive file contents through command output, and the owner can receive them through reports.

A witnessed delegation can bind up to eight attachment occurrences from owner messages. The authority imports only bytes that match a granted occurrence and its SHA-256 digest, under `input/<digest>/<safe name>` in the worker's workspace. A continuation retains the same input scope and workspace. Use fresh work to select different inputs. A Session that may retain imported bytes requires current disclosure permission for subsequent scripts, model calls, and broker access. [Select inputs in Assistant](../assistant/README.md#use-this-package)

The authority retains each export as a bounded snapshot for the owner entrance. Its witness receipt binds the work, recipient, size, and digest. The Host can read the snapshot after witnessing and while both disclosure permissions remain authorized. A restart recovers the retained snapshot from the authority database. Ordinary operation status returns file metadata only. Each admitted transfer takes one reservation. Previously delivered copies persist after disclosure permissions are revoked.

### Approve a shell command

With `approvalSocketPath` configured and `unattendedShell: false`, a shell proposal returns `pending-approval` and the exact script, source Session, grant revision, and payload digest for review. The Assistant presents the script and identifies the isolated `/workspace`. The trusted Host calls `OperationControlClient.decide` on the approval socket with the operation ID, revision, digest, and `approve` or `deny`. The operation socket serves proposal, execution, status, and cancellation requests.

Approval binds one operation to the reviewed script. The authority issues a permit after it records approval and the witness acknowledges admission. Denial cancels the reservation and records a revocation with reason `approval-rejected`. Denied and canceled reservations count toward the grant budget. Model calls and Assistant handoffs use their existing grants.

<a id="enable-https-business-requests"></a>
### Enable HTTPS business requests

Mount the broker and a credential provider in the authority profile. Add `inject: ['operationBroker']` to the operation-control row so it waits for the broker service. In that row's `config`, set `broker: ['operationBroker']` and configure `approvalSocketPath`. To mount several providers, list each provider's service name in both `inject` and `broker`. Use the Apple VM execution provider with `allowedTargets: []`, or the Docker execution provider with `gatewaySocket`. The authority refuses broker mode with raw CONNECT targets or without a gateway socket. The operator configures each action's fixed HTTPS `POST` endpoint and bearer credential reference. An empty route table refuses every action. [Broker configuration](../operation-broker/README.md#use-this-package)

From an admitted shell execution, submit the action ID and JSON body using the URL and request token in `DSH_BROKER_URL` and `DSH_BROKER_TOKEN`. This token is valid only during the current execution. The authority supplies the parent execution ID and proposal key to the broker, then reserves the prepared request as a separate operation. The approval shows the requested action, request method and destination, and the complete outgoing JSON. A broker can also show a readable preview derived from that same saved request. The broker resolves the external bearer credential in the authority after the permit is consumed.

This example assumes the operator has configured the `create-record` action. Run it inside the work Session's `exec` script.

```sh
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto'

const { DSH_BROKER_URL: url, DSH_BROKER_TOKEN: token } = process.env
if (!url || !token) throw new Error('No active broker request capability.')

const requestKey = randomUUID()
let response, result
try {
  response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestKey, action: 'create-record', body: '{"title":"Example"}' }),
  })
  result = await response.json()
} catch {
  throw new Error(`No broker reply for ${requestKey}. Inspect the authority record before submitting again.`)
}
if (!response.ok || !Number.isInteger(result?.status)) {
  console.error(JSON.stringify(result))
  process.exitCode = 1
} else {
  console.log(JSON.stringify(result))
}
NODE
```

The local gateway can return HTTP `200` with a structured error, so check the JSON for a numeric `status` or a boolean `toolError`. A witnessed response includes `id`, `receipt`, and either `status`, the remote HTTP status, or `toolError`, whether an MCP server marked its tool result as an error. For an action whose route returns its response, the reply also carries the response text as `body`, or `bodyOmitted` with the reason it is missing. The text is returned only when the root ceiling and the work grant both allow `data.returnResponses`; otherwise the request is still sent and recorded, and `bodyOmitted` is `not-permitted`. A grant recorded without this field withholds response text. The authority passes that text to the waiting script without retaining it; a lost reply cannot be read again. The witnessed outcome records the text's SHA-256 as `responseDigest`, or the reason as `responseOmitted`. Verify business completion with the target service. When a response or receipt is unavailable, inspect the authority record before submitting again. The authority and broker do not automatically retry dispatch.

<a id="repeated-business-requests"></a>
### Repeat a business request

An unattended rule does not admit a business request to the same action as an earlier business request under the same grant whose outcome is unresolved. The earlier outcome is unresolved unless the request was canceled before dispatch, the broker reported it as not sent, or a witnessed lookup or owner determination confirmed that it succeeded or failed. This covers a request awaiting a decision or admission, a dispatch in progress, an unknown outcome, and a response without confirmed business completion. The match spans every Session and work assignment under the grant, so a continuation or another worker cannot avoid it. The repeat waits for the owner's decision; its review carries the earlier operation ID in `repeats`, and the Host's approval card says that approving may repeat the effect. A request that no rule covers carries the same notice. The script receives the usual pending-review behavior. The authority looks for the earlier request in the database transaction that reserves the new one, so two concurrent requests to the same action cannot both be admitted without a decision.

### Reconcile business operations

Configure the broker route's `reconciliationEndpoint` before submitting an operation. The approval binds this lookup destination alongside the original request. The endpoint must implement the [broker's receipt protocol](../operation-broker/README.md). An earlier operation without that destination cannot acquire a verifiable result by guessing a route.

In the entrance, use `inspect_business_operations` with the worker's `session_id`. Set `reconcile: true` to make one read-only lookup for each eligible unresolved operation on the returned page. Use `after` with the returned `next` value to inspect another page. This tool never sends the original POST. It records its result through the existing tool history.

The Host can read a work assignment's business records with `HandoffControl.businessOperations`. Inspection reads retained evidence. `HandoffControl.reconcile` requests a lookup for an eligible operation or finishes witnessing a retained observation.

`businessCompletion` distinguishes `unconfirmed`, `pending`, `succeeded`, and `failed`. A lookup confirms success or failure with a matching external receipt retained by the witness; an owner determination is marked `source: owner` and carries the witness receipt without an external `receiptId`. A missing record, an invalid response, or a lost connection does not establish failure. HTTP status and Agent reports do not establish business completion. The original dispatch state and outcome remain available even when a later lookup confirms success. A witnessed `succeeded` or `failed` result lets an unattended rule admit requests to that action again; any other result keeps requests to that action waiting for a decision. [Repeated requests](#repeated-business-requests)

A request is eligible for a lookup when the witness holds its admission, under the owner's approval or an unattended rule, and its dispatch ended with a response or an unknown outcome; a denied request was never sent and has none. The authority checks the current principal and applicable work permissions before a lookup; the broker checks the saved destination against its current route before sending GET. Current POST size limits do not revalidate an already dispatched body. Lookups do not reserve another execution slot. Concurrent callers share the same lookup; a confirmed terminal result is returned without another external request. Each attempt retains its intent before GET and its observation before publishing the result. After restart, an explicit inspection can request another read-only lookup; if its observation already exists, only its witness receipt is retried. There is no automatic polling or resending.

<a id="read-business-records"></a>
### Read business records

The Host reads the business requests of every Session with `HandoffControl.businessRecords(after)`. The Unix provider calls `OperationControlClient.businessRecords(after)`, which sends `POST /business-records` with JSON `{"after":"<operation UUID>"}` on the approval socket; omit `after` for the newest records. The operation socket refuses it with `approval-forbidden`. A page lists up to 50 records, newest first in reservation order, and ends earlier when the next record would exceed the 1 MiB response limit; `next` is the cursor for older records. An `after` that names no business record is refused with `business-cursor-invalid`. Each record has the business status fields, `method`, `endpoint`, `tool` when present, the exact request `body`, and `workId` when present. The read changes no record and requests no evidence.

In business records and business status, `approval` is `approved` or `denied` for a human decision and `unattended` for a request an unattended rule admitted without one. It is absent while a request awaits a decision and after a request was canceled before one. When the authority upgrades a database written before it recorded `unattended` (schema version 10 or earlier), it sets that value on each business request without a decision that awaits its admission evidence or holds an admission receipt; in a database that an earlier build already upgraded to version 11, a request that was awaiting its admission evidence stays canceled with no `approval` value. Such a database does not distinguish a request canceled before its admission receipt from one canceled before a decision, so both keep `approval` absent.

On **Business records**, the owner can choose **I checked: it happened** or **I checked: it did not happen** for an unresolved operation whose dispatch ended with a response or an unknown outcome. The row identifies the owner as the source after the witness confirms the determination. This also works for MCP actions and HTTPS routes without a lookup endpoint. It leaves the dispatch record intact, releases that operation's action hold, and updates derived work outcome counts just as a confirmed lookup does. A canceled, unsent, running, or already confirmed operation cannot receive an owner determination.

`HandoffControl.resolveBusiness({ id, kind })` and `OperationControlClient.resolveBusiness({ id, kind })` send `POST /resolve-business` on the approval socket, where `kind` is `succeeded` or `failed`. The operation socket refuses it with `approval-forbidden`; no model or worker tool exposes it. The authority retains the determination in the reconciliation observation and obtains its receipt before the determination takes effect. Without witness confirmation, completion stays unconfirmed and the hold remains; reread records before trying again. A later reconciliation request can retry the retained observation's receipt without an external lookup. The authority database uses schema version 13; earlier records remain intact, and an older authority cannot reopen it.

### Compare records with the witness

`@deepseek-ai/dsh-operation-control/library` exports `OperationControlClient` and `verifyRecords`. `verifyRecords(approver, evidence)` reads every witness event with `EvidenceClient.list` and compares each admission, outcome, and revocation event of an operation with the receipt the authority holds for it. It obtains those receipts with `OperationControlClient.receipts(ids)`, which sends `POST /operation-receipts` with JSON `{"ids":["<operation UUID>", ...]}`, up to 50 IDs, on the approval socket; the operation socket refuses it with `approval-forbidden`. The reply lists the `admission`, `outcome`, and `revocation` receipts of each requested operation the authority has and omits the others. The caller needs access to both the approval socket and the witness socket.

Each reported problem names a witness event ID. `operation-missing` means the authority has no record of an operation the witness holds. `receipt-missing` means the authority has the operation but not this receipt; this also happens when the authority stopped after the witness acknowledged the event and before the authority committed its receipt, and after restart the authority settles that operation as unknown or canceled. `digest-mismatch` means the authority's receipt names different content than the witness's event. The result reports each problem without determining which of these causes applies. A witness page whose `next` does not exceed the position it was read after stops the comparison with an error. The comparison also reads the configuration receipt from `OperationControlClient.grant()` and checks it against the witness's event with that ID; `event-missing` means the witness has no such event, and the result lists it after the others. Events for earlier configurations, grant limits, unattended rules, credential changes, and business lookups have no receipt to compare; the result counts them in `other`. If the authority's configuration record is still unconfirmed, the first privileged request, which verify makes, finalizes it once the witness confirms it; otherwise the comparison changes nothing.

### Enable model requests

Add `@deepseek-ai/dsh-llm` and one LLM adapter to the authority profile's dependencies and mount both plugins there. For an API provider, mount [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) with a route such as `openai` whose `apiKeyEnv` names a credential in the authority's credential store or process environment. For Local Codex, mount [`@deepseek-ai/dsh-llm-codex`](../llm-codex/README.md), whose route is `codex-local` with the model `default`, and sign in to Codex as the authority account. Set `model.provider` and `model.model` on the authority and mount `@deepseek-ai/dsh-operation-control/model-agent` on the Agent Host with the same `provider` and `model` and the authority `socketPath`. Select that route and model for the Host's Sessions. The Host proxy accepts Session requests for that route, and the Host can use it without access to the authority's model credential.

The Host proxy's optional `timeoutMs` defaults to `180000`. Disable the model-generated Session title when using this proxy. Its generation controls require a different route.

### Enable delegation and response delivery

Set `assistant.mainSessionId` on the authority and mount `@deepseek-ai/dsh-operation-control/handoff` on the Host with `socketPath` and optional `timeoutMs`. The Assistant overlay mounts this provider. The abstract `HandoffControl` service is the replacement point: its `release` method must bind the source, target, content, and stable request key to a current grant and a durable witness receipt before returning.

The authority stores the exact handoff content as a durable outbox release. Delegation releases authorize the Host to admit that work; delivery releases authorize publication of the buffered entrance response. The receipt confirms this release, not worker completion, browser receipt, or a business outcome. The same key cannot release different content. Rechecking a release consumes no additional reservation and requires the current configuration revision and a valid expiry. After the owner renews an expired grant, the Host can recover a consumed release with the original request key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [store](src/store.ts) binds the exact script or projected model request to the Session, config revision, and reservation. The [authority](src/authority.ts) checks the current grant and commits consumption before calling its isolated execution provider or Local Codex adapter. A shell observation includes exit status and confirmed container stop. A model observation includes the completed response stream. The authority retains that stream and releases it only after the witness records its digest and any reported usage. A command can affect the workspace even if it returns a nonzero exit code or loses its response.

On restart, an unanswered shell review remains pending. A recorded shell approval can recover its admission receipt and still needs an explicit execution request. The authority cancels unconsumed broker requests because their parent shell execution has ended. An operation with recorded consumption and no observation becomes `unknown`. Operations with a recorded observation can recover its witness receipt. A configuration change advances the durable revision once the witness confirms its configuration record, which invalidates earlier approvals and unconsumed permits; the owner's unattended rules stay saved, each action's under its route digest. [Socket recovery and lock files](../operation-evidence/README.md#understand-the-implementation)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profiles](../../boot/app-boot/README.md#profiles) — start separate Harness compositions.
- [Execution container](../execution-container/README.md) — select and configure an isolated workspace backend.
- [Evidence witness](../operation-evidence/README.md) — operate the separate receipt store.
- [Assistant](../assistant/README.md) — delegate work and inspect Session results.

-----

<a id="model-experience"></a>
## Model Experience

### Execution result

#### What the model sees

The Agent Host's `exec` tool returns the observed exit and output, the operation ID, and a witness digest. A declined shell approval produces a tool failure with the operation ID. If the script prints its broker reply, the model can see the remote HTTP status and receipt or the broker error code in the tool output.

#### Token effect

Each operation ID and witness digest add text to the `exec` result.

#### KV Cache effect

Operation results add tool-result content to the next model request.

### Business inspection

#### What the model sees

The entrance's `list_business_actions` tool returns the broker actions the Assistant grant permits, with each provider's usage text. The entrance's `inspect_business_operations` tool returns recorded dispatch states, business completion, receipt identifiers, and witness evidence for the selected worker Session. Lookup errors remain unconfirmed results. [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-operation-control)

#### Token effect

Each returned operation adds its status and evidence to the tool result.

#### KV Cache effect

Inspection results become tool messages in the entrance's next model request.

### Model requests

#### What the model sees

The authority sends the projected text history and available Harness tool schemas through the LLM adapter mounted for the configured route.

#### Token effect

Mediation adds no model-visible text. The authority counts each admitted request as one operation.

#### KV Cache effect

The mounted LLM adapter owns request projection and cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The grant covers isolated `exec`, broker requests, scoped file transfers, the configured model route, and configured entrance delegation and response releases. A model permit covers one model request. Worker-to-entrance report notices and inspection APIs retain their separate access controls.
- Socket access identifies one operator-assigned principal. The Host is trusted to select Session identities. Assistant operations require the entrance or an authority-issued work binding; the work scopes share the deployment budget. Every durable reservation counts, including canceled and unknown operations.
- The witness retains authority-reported facts in its own process and database; it is administratively independent of the authority only when it runs under its own OS account. A receipt establishes retention and integrity of the event, and the tool outcome reports the runner's observations. Business completion requires the configured lookup service's receipt and its independent retention.
- The configuration record covers the configuration in effect from each start, not the profile file. A profile edit reverted before the next start leaves no record, and the record omits plugins other than this one, the Host and Web profiles, and broker route endpoints beyond the broker fingerprint.
- The authority database contains projected model inputs, completed responses, exact handoff payloads, exact broker request bodies, and imported and exported file bytes. Restrict its access to the authority account.
- A broker provider limit that changes what is sent or returned for its actions, such as `maxBodyBytes`, is part of each of their route digests. Changing it turns off the owner's unattended rules of every such action until the owner saves them again or the operator restores the limit.
- The socket caps ordinary requests at 256 KiB and ordinary responses at 1 MiB, including protocol fields. The `/propose-file` upload and `/read-export` download have separate limits for Base64 encoding and protocol fields. A model response that exceeds its available space leaves an unknown outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package tests use separate Unix sockets and SQLite stores under one test UID. Deployment isolation depends on the provisioned account, directory, and daemon ownership.

</details>

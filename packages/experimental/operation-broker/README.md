---
description: "Send approved JSON requests to operator-configured HTTPS routes and MCP tools with authority-owned credentials."
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-broker

English | [中文](README.zh.md)

## Summary

Prepare an exact HTTPS JSON request for authority review and send it after approval. For routes with a status endpoint, look up the business outcome without resending the request. The operator selects the endpoints and bearer credential reference for each action. The caller supplies only the action ID and JSON body. A second provider in this package calls operator-selected tools of remote MCP servers under the same review.

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

Mount the broker alongside the credential provider and operation authority in the authority's `dsh` profile. Keep the credential provider and its values under that account. Set `routes: []` until an operator has configured an endpoint and its credential reference.

<a id="example-route"></a>
### Example route

Replace the example endpoints with canonical HTTPS URLs, including their paths. Configure the referenced bearer token in the authority's credential provider. Omit `reconciliationEndpoint` for a route without a read-only status endpoint. Set `description` to tell the requesting model what the action does and which JSON body it takes. The text is at most 2000 characters and reaches the model verbatim. Set `returnResponse: true` on a route whose response text the requesting work environment needs, such as a read. The authority returns that text only to work whose grant allows `data.returnResponses`; there it can reach the model. The broker returns complete UTF-8 text of at most `maxResponseBytes` (default `32768`) and omits a larger, non-UTF-8, interrupted, or credential-echoing response while still reporting the status.

```yaml
- name: '@deepseek-ai/dsh-operation-broker'
  config:
    routes:
      - action: create-record
        description: 'Create one record. The body is {"name": string}.'
        endpoint: https://records.example.com/api/records
        reconciliationEndpoint: https://records.example.com/api/records/status
        credentialRef: RECORDS_API_TOKEN
```

The `timeoutMs` deadline defaults to `15000` and covers credential lookup through POST response headers or the complete status response. `maxBodyBytes` defaults to `32768` UTF-8 bytes. The POST body must be valid JSON text and is sent with its original formatting. Every POST and status GET carries `Authorization: Bearer <token>` and `User-Agent: deepseek-harness`; the POST also carries `Content-Type: application/json`, `Idempotency-Key`, and `X-DSH-Request-Digest`. [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-operation-broker)

<a id="private-certificate-authorities"></a>
### Private certificate authorities

Set `ca: /absolute/path/company-ca.pem` on an HTTPS JSON route or on an MCP `servers` entry to trust a private CA for that destination only. The authority reads and parses the PEM file when the provider loads; an unreadable or invalid file fails loading. The HTTPS route uses it for both dispatch and status lookup. The MCP endpoint uses it for every request in that connection and retains the configured proxy policy. With `ca` set, these certificates replace the default trust roots for that destination. Certificate-chain and hostname verification remain enabled; there is no verification bypass.

Keep the file readable by the authority and restart after changing it. The resolved path and SHA-256 digest of its contents are included in the action's `routeDigest` and the provider fingerprint, which the authority's witnessed configuration records. A change therefore invalidates unconsumed permits and makes saved owner rules for that route inactive until the owner saves them again or the route is restored. Omitting `ca` retains Node's default trust roots. Process-wide `NODE_EXTRA_CA_CERTS` also affects other connections; it is unnecessary for these scoped routes.

### Status endpoint

The business service must record the `Idempotency-Key` and `X-DSH-Request-Digest` headers with its operation. The broker reads status with an authenticated GET to the configured endpoint on the POST's origin. It adds the headers' values as the reserved query parameters `operationId` and `payloadDigest`.

A status response uses HTTP 200 and a UTF-8 JSON body of at most 4096 bytes. It returns the exact `operationId` and `payloadDigest` alongside `status` set to `pending`, `succeeded`, or `failed`. A terminal status requires a stable, opaque `receiptId` of 1–128 ASCII letters, digits, or `._~-` characters. The business service issues the terminal receipt only when its records establish that outcome for the matching operation.

<a id="mcp-tools"></a>
### MCP tools

Mount `@deepseek-ai/dsh-operation-broker/mcp` to offer selected tools of remote MCP servers as broker actions. It registers the service `operationBrokerMcp`; add that name beside `operationBroker` to both the `inject` list of the authority's `operation-control` row and its `broker` setting. Each server needs a canonical HTTPS Streamable HTTP endpoint and a bearer token reference. List every permitted tool with its own action ID; a tool the server lists but the table omits cannot be called. The requester's JSON body must be an object. The provider saves `JSON.stringify` of the validated arguments for storage, review, hashing, rule matching, and the tool call.

```yaml
- name: '@deepseek-ai/dsh-operation-broker/mcp'
  config:
    servers:
      - url: https://notes.example.com/mcp
        credentialRef: NOTES_MCP_TOKEN
        tools:
          - action: notes-create
            tool: create_note
            description: 'Create one note. The body is {"title": string, "text": string}.'
            returnResponse: true
```

Write `description` yourself: the provider never forwards the server's own tool description, so only text the operator reviewed reaches the model. For each admitted request the provider opens a connection through the [MCP client](../../mcp/mcp-client/README.md), calls the tool, and closes the connection. `timeoutMs` defaults to `60000` and bounds the credential lookup, the connection, and, separately, the call. `maxReadBytes` (default `16777216`, at most `67108864`) bounds the bytes the provider reads from the server for one call, counting every HTTP response body of the connection, the handshake included. It protects the authority process from an unbounded stream; the default leaves room for results that carry images or embedded resources, which the provider reads whole although it returns only text. Exceeding it closes the connection: during the handshake the call is reported as not sent, and after the call was sent its outcome stays unknown. The result reports whether the server marked it as an error. With `returnResponse`, the result's text blocks are returned when they fit in `maxResponseBytes` (default `32768`) UTF-8 bytes; larger or credential-echoing text is omitted and the call still completes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The separately built MCP entry shares the main entry's `OperationBroker` class so the authority recognizes it as a broker provider.

The authority passes the parent execution ID and proposal key to `OperationBroker.resolve` before reservation. A provider prepares the same route and outgoing body for repeated inputs under the same configuration. The HTTPS JSON provider preserves the caller's exact body. It checks the stored route against its current configuration and resolves the bearer token independently for each POST and status GET. The deployment fingerprint covers the route and limits without reading credential values. `OperationBroker.actions` lists each configured action with its usage text and credential reference. The fingerprint excludes the usage text. [Service definition and HTTPS provider](src/index.ts)

Each listed action also carries `routeDigest`, a SHA-256 digest of where a request for that action goes and what comes back. The authority binds the owner's unattended rules of an action to it. When `ca` is set, it also covers the resolved CA path and content digest. For an HTTPS JSON route it covers the method, `endpoint`, `reconciliationEndpoint`, `credentialRef`, `returnResponse`, and `maxBodyBytes`, plus `maxResponseBytes` when the route returns its response. For an MCP tool it covers the server `url`, `tool`, `credentialRef`, `returnResponse`, and `maxBodyBytes`, plus `maxResponseBytes` when the tool returns its result. It excludes `description` and `timeoutMs`, and for an MCP tool also `maxReadBytes`: they change neither what is sent nor what reaches the requester. Another action's route does not affect it. The provider fingerprint covers every field the digest covers. [Edit unattended rules](../operation-control/README.md#edit-unattended-rules)

A provider can supply a human-readable preview of the saved request during approval. The authority also shows the complete outgoing JSON and binds the decision to the saved request digest and grant revision.

Each call verifies the endpoint certificate and sends one request. The POST returns only its HTTP status. A status GET returns a normalized business status and, when terminal, its receipt ID. Redirects and retries are disabled.

`@deepseek-ai/dsh-operation-broker/library` exports `isBearerToken` and `isBrokerReceiptId`, which the authority uses to check stored tokens and receipt IDs.

-----

<a id="further-exploration"></a>
## Further Exploration

- Use the operation authority to review requests and retain receipts. [Operation control](../operation-control/README.md)
- Configure an authority-local source for bearer tokens. [Credentials](../../credentials/credentials/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the operation authority's caller-facing results.

#### KV Cache effect

The broker contributes no request prefix. The calling tool owns any retained result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A POST response reports transport status. Use the business service's records to establish whether the change completed.
- A missing, mismatched, or unusable status response leaves the outcome unresolved. With no configured status endpoint, check the service's records manually.
- MCP has no lookup for a past tool call. An MCP request whose result was not observed stays unresolved until someone checks the service.
- The MCP provider supports Streamable HTTP with a bearer token. Servers that require OAuth or run as a local process are not supported.
- An MCP result of any size needs room in `maxReadBytes`, even for an action without `returnResponse`, because the provider reads the result to learn the call's outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

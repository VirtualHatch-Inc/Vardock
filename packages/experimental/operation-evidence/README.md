---
description: "Preserve execution admission and outcomes in a separate witness process over a Unix socket."
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-evidence

English | [中文](README.zh.md)

## Summary

Preserve execution admissions and outcomes in a process separate from the Agent Host and execution broker; it is administratively independent of them only under its own OS account. The witness commits each event to SQLite before acknowledging it. Use a stable event ID to recover a receipt after a lost reply.

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

Run a dedicated `dsh` profile under the witness's own OS service account. Keep its installed code and profile configuration outside the Agent Host and broker's write access. Put the SQLite database in a witness-owned directory with mode `0700`. Place the socket in a separate witness-owned directory without group write or access for other users. Grant access only to the execution broker. On Linux, use a dedicated broker group on a setgid socket directory with mode `2750` and set `socketMode` to `'0660'`. Keep the witness outside the authority of any rootful Docker daemon accessible to the broker or Agent Host.

### Minimal configuration

Mount the plugin with existing witness-owned parent directories. Set `socketMode` to match the broker's access.

```yaml
- name: '@deepseek-ai/dsh-operation-evidence'
  config:
    socketPath: /run/dsh-witness/evidence.sock
    databasePath: /var/lib/dsh-witness/evidence.sqlite
    socketMode: '0660'
```

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | required | Absolute Unix socket path. |
| `databasePath` | required | Absolute SQLite file path. |
| `socketMode` | `'0600'` | Owner access or owner and group access with `'0660'`. |
| `timeoutMs` | `5000` | Request timeout in milliseconds. |
| `maxRequestBytes` | `65536` | Maximum append body size in bytes. |

Use the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-operation-evidence) for field validation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service](src/index.ts) exposes append and lookup over the Unix socket. The [client](src/client.ts) verifies receipts against the SHA-256 digest of the event's canonical JSON. Consumers use `digestEvidenceEvent(event)` to calculate that same receipt digest. `@deepseek-ai/dsh-operation-evidence/library` exports `EvidenceClient`, `digestEvidenceEvent`, and `prepareOperationSocket`, the socket-path preparation that the authority and the gateway share. Appending identical data under an existing ID returns its receipt. Different data under that ID produces a conflict. If an append's outcome is unknown, look up the ID or resend the identical event.

`GET /events?after=<n>` lists committed events in commit order, 50 per page, starting after position `n`; pass `0` for the first page. A full page carries `next`, the position to pass for the following page. `EvidenceClient.list(after)` reads one page and rejects any record whose digest does not match its event. Listing changes nothing in the database. Any process that can connect to the socket can list every event, so socket access controls who reads the record as well as who appends to it.

Each running service holds exclusive access to its SQLite database and a lock in `<socketPath>.lock`. Leave the lock file in place across restarts. After a crash, the next instance can reclaim a service-owned socket if a connection is refused. If startup reports an occupied socket or cannot determine its state, inspect the path and the listening process before restarting.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profiles](../../boot/app-boot/README.md#profiles) — launch the witness in a dedicated composition.
- [Execution container](../execution-container/README.md) — isolated execution workspaces.
- [Assistant](../assistant/README.md) — delegation and work Sessions.

-----

<a id="model-experience"></a>
## Model Experience

None, as the witness serves broker requests over a private socket.

#### KV Cache effect

The calling tool owns any receipt it includes in a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The database depends on the witness administrator for retention and backups. The service records broker-supplied execution facts, and the digest identifies the retained content.
- The service uses Unix sockets on macOS and Linux. The broker needs read and append access to the socket and a request limit compatible with the witness.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

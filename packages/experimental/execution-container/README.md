---
description: "Run approved Session scripts in an isolated Docker container or Apple Linux virtual machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-container

English | [中文](README.zh.md)

## Summary

Run a work Session's shell scripts in an isolated Linux workspace. Files in `/workspace` stay with the Session across calls and explicit continuations. Docker workspaces have no network device other than loopback and run under a selectable OCI runtime. Apple container workspaces run in dedicated Linux virtual machines, with optional outbound traffic through an operator-configured gateway. With a gateway socket, both backends can carry approved business requests to the operation authority.

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

Mount the provider in the [operation authority](../operation-control/README.md) profile alongside `@deepseek-ai/dsh-subprocess-local`. The Agent Host reaches it through the authority socket.

### Minimal configuration

```yaml
- insert:
    - id: isolated-execution
      name: '@deepseek-ai/dsh-execution-container'
      config:
        backend: docker
        dockerSocket: /run/user/1001/docker.sock
        image: dsh-execution:local
```

For Docker, supply an authority-owned daemon socket and preload a trusted Linux image with `/bin/sh`, `/bin/sleep`, and `/bin/chmod`. Register the selected `runtime` with the daemon. Choose an image without declared Docker volumes or embedded credentials. For Apple container on Apple silicon, follow the [macOS setup](../assistant/vardock/README.md) to preload the [execution image](Dockerfile) and configure the authority.

| Field | Default | Meaning |
|---|---|---|
| `backend` | required | `docker` or `apple-vm`. |
| `image` | required | Preloaded execution image reference. |
| `dockerSocket` | required for `docker` | Local Docker daemon Unix socket. |
| `runtime` | `runc` | Docker's OCI runtime: `runc`, `runsc` (gVisor), or `io.containerd.kata.v2` (Kata Containers). Changing it makes existing Session containers conflict. |
| `gatewaySocket` | required for `apple-vm`; optional for `docker` | Stable Unix socket path in an authority-owned directory with mode `0700`. For Docker, setting it enables business requests. |
| `allowedTargets` | `[]` | Apple VM gateway's exact allowed `host:port` targets. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-execution-container) lists the executable names, deadlines, and resource limits. The authority verifies the preloaded image before admitting calls.

The Apple VM has no direct network access. The gateway denies all CONNECT destinations by default. To use an allowed plain HTTP target with curl, use `--proxytunnel`. The gateway resolves listed DNS names to public IPv4 addresses. To allow an internal service, explicitly list its literal IP and port. The gateway checks the destination of each tunnel. Application credentials and authorization remain with the destination service.

An authority can attach a business request handler to a shell call when the backend has a gateway socket: always for Apple VM with an empty `allowedTargets`, and for Docker when `gatewaySocket` is set. The shell receives `DSH_BROKER_URL` and a per-call `DSH_BROKER_TOKEN`; transfers and calls without a handler receive neither. Both CLIs forward those variables by name from their process environment; the token value is not placed in Host argv. Send UTF-8 JSON with HTTP POST and `Authorization: Bearer <token>`. The gateway accepts requests up to 256 KiB and responses up to 1 MiB. The authority defines the request fields, approval rules and results. [Operation authority](../operation-control/README.md)

In an Apple VM, an in-guest socat listener on `127.0.0.1:3128` forwards each request to the gateway socket, which is mounted into the VM. A Docker container has neither a network device other than loopback nor a mounted socket. For a call with a handler, the provider starts a relay with `docker exec` as the container's non-root user before the script. The relay listens on `127.0.0.1:3128` and writes each request as one JSON line to its standard output. The authority process reads the lines, replays each request to the gateway socket, and writes the response line back. The gateway applies the same credential check, byte limits, and drain as for an Apple VM request. The relay runs inside the container as the same user as the script, so a script can stop, replace, or impersonate it. The Host pump and the gateway, not the relay, enforce the credential check, the limits, and the line protocol. The Host rejects a malformed line, an oversized line, a reused request ID, or more requests in flight than `gatewayMaxConnections`, then stops the relay and logs a warning. A cancelled request stays in flight, and its ID stays taken, until its replay to the gateway has closed. The image must include `/usr/local/bin/node` for the relay.

Both backends support byte-for-byte input import and artifact export through the authority. The trusted image must include `/usr/local/bin/node` for transfers. The authority sets a file size limit up to the provider's 32 MiB maximum. Imports use relative paths under `input/` and accept a previously imported file only when its bytes match. Exports select a regular workspace file by relative path. Symbolic links and hard links are refused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [Docker runner](src/docker.ts) identifies the container by Harness home and Session ID, then verifies its ownership labels, image, OCI runtime and limits before use. A conflicting container is refused with `EXEC_CONTAINER_CONFLICT` and left untouched. The operator must inspect its ownership and workspace before removing it; remove it only when that workspace is no longer needed. The next call creates a new container and workspace. The runner configures a read-only root, no network device other than loopback, all capabilities dropped and privilege escalation disabled. Its `/etc/resolv.conf` names only `127.0.0.1` and no search domain, so the work environment does not see the Host's DNS servers or search domains. Scripts run as a numeric non-root user with a Docker-managed volume at `/workspace`.

For a call with a handler, the Docker runner registers the credential, starts the container and the [relay](src/relay.ts), and waits for readiness under the execution deadline. The script starts only after the relay is ready. When the script ends, fails, is cancelled or times out, the runner withdraws the credential, confirms the container stopped, terminates the relay command and waits for admitted requests and relay closure. In this configured path, an unconfirmed stop leaves no valid credential or live relay connection to the gateway. When its standard input closes, the relay answers pending requests with status 502 and exits.

The [Apple VM runner](src/vm.ts) gives each Session its own microVM with a persistent volume, a read-only root filesystem, and no network device other than loopback. The non-root guest reaches the Host gateway through one Unix socket forwarded over vsock. The execution image supplies Node.js and socat for the guest loopback proxy and its startup check.

The runner supplies `DSH_BROKER_URL` and `DSH_BROKER_TOKEN` through the script CLI's process environment and names them in `exec --env` arguments, without putting token values in Host argv. On Linux, the subprocess launcher briefly writes the environment into a private request file, mode 0600 in a mode-0700 directory; its bootstrap unlinks that file when it consumes it. The gateway routes the per-call credential to that call's handler, withdraws it on cancellation or shell exit, and waits for admitted requests before returning the result. The shell deadline and gateway inactivity timeout apply while a request awaits a decision.

Before reopening the gateway, the Apple VM runner stops any active VMs it previously assigned to that socket. A Session recovered this way reports its interruption on the next call. If VM shutdown cannot be confirmed during a call, the runner closes the gateway and stops accepting work. Apple VM evidence uses the SHA-256 of the container name as its opaque identity.

The [service](src/service.ts) gives the authority one execution lease for its workspace namespace. The authority waits for the resolved policy before admitting work and disposes the lease at shutdown. A transfer reserves the same workspace as shell execution, uses a fresh guest invocation, and returns the SHA-256 digest and byte count after confirmed stop. Both backends stop the container after each call, including after cancellation, and retain the volume. The provider reports an unknown outcome when it cannot confirm stop. If the next call finds an interrupted container still active, the provider stops it and reports the interruption. Inspect the files before repeating a script that may have made partial changes.

`@deepseek-ai/dsh-execution-container/library` exports what the authority uses beside the service: `createExecTool`, `renderExecutionObservation`, `isWorkspaceTransferPath`, and `MAX_WORKSPACE_TRANSFER_BYTES`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Assistant](../assistant/README.md) — role access and explicit work continuation.
- [Subprocess service](../../subprocess/subprocess/README.md) — CLI process management and output collection.
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/) — inspect and remove retained storage.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the authority-backed [`exec` tool](../../../docs/tool-catalog.md#deepseek-aidsh-operation-control), whose description names the supplied shell, Node.js runtime, broker request format, and separate script and external-request approval policies, with byte-limited command output recorded in Session history.

#### KV Cache effect

An unchanged schema can remain in a cached prefix. Command output enters later requests as a tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Use one operation authority for each set of work Sessions. Backends keep stopped containers and their workspace volumes until an operator removes them. When switching backends, transfer any workspace files needed for continuation.
- The provider supplies no per-Session disk quota.
- All executions of one provider share the gateway's `gatewayMaxConnections`. One Docker relay may hold that many business requests in flight, and one Apple VM may open that many gateway connections. While they are pending, the gateway drops every other execution's request, and that script sees a closed connection. The provider reserves no share per execution because the number of concurrent executions has no bound.
- Docker configures a read-only root, a non-root user, no capabilities, memory and PID limits, and no network device other than loopback. The PID setting does not bound guest processes under gVisor. The configured communication path is broker-only, with each request admitted by the authority; these settings are not proof against kernel compromise. runc shares the Host kernel and is not a VM boundary. runsc uses gVisor's user-space kernel. A functioning Kata deployment provides a VM boundary in kind and needs KVM, but this project has not verified it. Rootful Docker access grants root-equivalent Host control; a host-kernel compromise is not limited to a rootless daemon's account. In a single-account deployment, that account holds the authority's credentials, records and witness.
- Under `runsc`, `pidsLimit` counts sandbox Host tasks, about 29 at idle on the test host, and does not bound guest processes. With `gatewaySocket` set, the provider refuses a `pidsLimit` below the measured operating minima: 20 for `runc` and 48 for `runsc`. The keeper, relay and a shell running a Node script with fetch and its thread pool peaked at 20 tasks under `runc` and 45 under `runsc`. Kata's operating minimum is unknown.
- Linux verification scope: one arm64 Ubuntu VM with Docker 29.9, runc 1.5 and gVisor release-20261109. Measurements there included 16 concurrent relay requests of about 200 KiB with responses of about 900 KiB, and shared loopback between `docker exec` processes under `--network none`. Broker round-trip p50 was 6 ms (`runc`) and 11 ms (`runsc`); cold start 360–430 ms and 400–530 ms; idle memory about 8 MiB and 19 MiB. Real-engine checks on that VM exercised isolation, persistent workspaces, stopping, broker delivery, credential expiry, concurrency and cancellation. These measurements do not verify other hosts or runtimes; the revised tests have not been rerun on Linux for this release preparation.
- Unverified: Kata did not boot under nested virtualization on the test VM; its VM isolation and operating limits remain unverified by this project. Evaluate it on a host with working KVM. x86_64, other Linux distributions and rootless Docker are also unverified.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Docker smoke test runs with `DSH_EXEC_TEST_SOCKET` and `DSH_EXEC_TEST_IMAGE` set; `DSH_EXEC_TEST_RUNTIME` selects the runtime. The image needs `/usr/local/bin/node`, such as the [execution image](Dockerfile). The Apple VM smoke test runs on macOS with `DSH_EXEC_VM_TEST_IMAGE` set and Apple container running. On Linux, the same Docker variables also run the [operation-control](../operation-control/tests/socket-restart.e2e.ts) business case end to end with `pnpm run test:e2e`. The tests create and remove containers for their own random Session IDs.

</details>

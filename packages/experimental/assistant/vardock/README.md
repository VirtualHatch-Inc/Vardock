# Run Vardock from source

English | [日本語](README.ja.md) | [中文](README.zh.md)

By default, setup writes `unattendedShell: true`: routine scripts run automatically in the network-less work environment, with admission and outcome evidence recorded and witnessed. The authority asks the owner at key points determined by fixed rules, never by a model: external business requests wait unless an owner rule admits them; notes and schedules retain approval. Add `--review-scripts` to setup to review every script. Existing deployments keep their settings. [Switch an existing profile](../../../../docs/upgrade-guide/v0.2.2-rc.2-vardock/automatic-scripts/guide.md)

Vardock builds on DeepSeek Harness (DSH). These commands prepare and manage its local Web Host, operation authority, and evidence witness. Each service still launches through a DSH profile. The standalone `pnpm dsh web` command starts the standard Harness Web profile. The following instructions describe macOS; see [Linux](#linux) for systemd and Docker.

Use a trusted macOS account. The three services share your user ID, so other processes under that ID can read or modify their state, reach their sockets, and control the VMs. The witness is a separate process, not an independently administered one. [Threat model](../../../../SAFETY.md#threat-model)

## Prepare the checkout

Use an Apple silicon Mac running macOS 26 or later, a native arm64 terminal, Node.js 24.9 or newer with its development headers, Xcode Command Line Tools, and the pnpm version pinned by `packageManager` in the root manifest. On macOS, the commands stop with `Use a native Apple silicon terminal and Node.js on macOS 26 or newer.` on any other host. Install Apple's `container` CLI and put it on `PATH`. [Root manifest](../../../../package.json) · [Apple Container installation](https://github.com/apple/container#initial-install)

On Windows and other unsupported hosts, `pnpm vardock --help` prints usage. Every other command stops with `Vardock supports macOS and Linux only.`

<a id="choose-a-model-provider"></a>
### Choose a model provider

Setup requires `--model-provider <route> --model <id>` and, when either is missing, stops before changing anything and lists the two kinds of route. For an LLM API provider, `<route>` is a provider route that the installed [pi-ai adapter](../../../llm/llm-pi-ai/README.md) catalog ships and that accepts an API key, such as `openai`, `anthropic`, `deepseek`, or `xai`. `<id>` is that provider's model ID. The authority checks the route and model when it starts and stops with an error in its `stderr.log` when the adapter does not know them.

Setup does not ask for the key. It names the key `<ROUTE>_API_KEY` in the authority profile, for example `OPENAI_API_KEY`. After the first start, enter the key under **Connections** on the Plugins page. The authority stores it in `<home>/authority/.credentials.yaml` and never shows it again. Model requests fail until the key is saved.

For Local Codex, pass `--model-provider codex-local --model default`, where `default` selects the Codex account's default model. Install the Codex CLI, put it on `PATH`, and sign in with `codex login` for this macOS account; setup stops with `Run codex login for this macOS account.` otherwise. Model requests then use that Codex account and its usage limits. Setup does not sign in, copy credentials, or send a model request. [Local Codex](../../llm-codex/README.md#use-this-package)

## Set up and start

Run from the checkout root with your provider route and model ID:

```sh
pnpm install
pnpm vardock setup --model-provider openai --model "<model-id>"
pnpm vardock start
```

For Local Codex, run `pnpm vardock setup --model-provider codex-local --model default` instead.

Setup checks the host, the pinned pnpm, the installed dependencies, the `container` command, and, for Local Codex, the Codex login. It then runs `pnpm run build:artifacts` and starts Apple Container with `container system start --enable-kernel-install` if it is not running; on first use this downloads and installs Apple Container's default Linux kernel. If the image `dsh-execution:local` is absent, setup builds it with `container build` from the [execution Dockerfile](../../execution-container/Dockerfile), which pulls `node:24-bookworm-slim` at the digest it pins and installs `socat` from Debian's package archive. Finally it writes private profiles and launchd job files to `$HOME/.vardock` and prints `Prepared Vardock in <home>. Run pnpm vardock start --home '<home>'.`; for an API provider route it adds `Then save the model API key under Plugins, Connections.`

Setup does not start the services. Start loads the witness, authority, and Web Host in that order, waits for each to become ready, prints `Vardock is ready.`, and opens the entrance in your default browser.

The Web Host loads the [Assistant overlay](../cordis.patch.yml), which disables the Web profile’s Office conversion (`office-kit`), Office skills (`skill-office`), account notification polling (`ui-account-notifications`), the MCP server manager (`mcp-manager`), the DeepSeek account service (`deepseek-account`), and Session telemetry export (`session-telemetry-otel`). The Host therefore writes no Office outputs, runs no Python for Office skills, starts no MCP servers from Settings, does not poll the account server, and exports no Session telemetry, and the document preview does not render Office files.

Keep the checkout in place: generated profiles reference its built packages. Setup refuses to overwrite an existing deployment; it does not reset grants, credentials, or saved work. A failed build or image preparation stops before generating profiles.

## Manage the deployment

| Command | Effect |
|---|---|
| `pnpm vardock setup` | Prepare a fresh deployment. |
| `pnpm vardock start` | Start the services or reopen a running deployment, then print `Vardock is ready.` |
| `pnpm vardock stop` | Unload Web, authority, and witness; retain their data and the shared Container service. Prints `Vardock is stopped.` |
| `pnpm vardock doctor` | Inspect prerequisites and deployment state without changing them. Prints `OK  <check>` or `Fix <check>. <action>` for each check and exits with status 1 when one fails. |
| `pnpm vardock verify` | Run while Vardock is running. Read every witness event and compare each operation event with the authority's receipts, then print `OK  Every compared event matches.` or one `Mismatch` line per problem with what its kind can mean, and exit with status 1. A `receipt-missing` mismatch also follows an authority stop between the witness's acknowledgment and the authority's own commit. An authority record the witness never received is not reported. Changes nothing. |

Append `--home /short/path` to select another deployment directory. Use the same path with every command.

Setup accepts `--port 3080` to select that port instead of an automatically assigned port. Start accepts `--no-open` to leave the browser closed. Use `pnpm vardock --help` for usage.

The launchd jobs use the fixed labels `io.github.virtualhatch-inc.vardock.witness`, `.authority`, and `.web`, which allow one active deployment per macOS desktop session. A deployment using those labels from another directory must be stopped with its own `--home` before starting this one. Commands do not take over or stop another deployment. They also refuse to act while a deployment prepared with the earlier labels `io.deepseek.dsh.assistant-dev.<role>` is loaded or in the selected home, and print the steps to migrate it. [Upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/vardock-launchd-labels/guide.md)

Start runs in your logged-in macOS desktop session. Run it again after logout or a Mac restart. launchd restarts loaded jobs if their processes exit. Stop unloads the jobs; it does not delete Sessions, operation records, or VM workspace volumes.

<a id="default-grant"></a>
### Default grant

Setup writes this grant into the authority profile: work may run shell scripts (`exec: true`), import and export files and disclose them to the model and to you, and receive the response text of external actions (all `data` permissions, including `returnResponses`), and request no broker actions (`brokerActions: []`). This grant is the ceiling: each delegation states the permissions its work needs within it. The grant allows 1,000 reservations (`maxOperations`), expires seven days after setup (`grantExpiresAt`), and transfers at most 8 MiB per file. Change the reservation limit and expiry under **Usage settings** in the entrance. Change permissions in the `operation-control` row's `assistant.permissions` while Vardock is stopped, as in [Connect a service](#connect-a-service). `unattendedShell` can be set only in that row; no page changes it.

Setup writes these limits. Change the authority values in `<home>/authority/profiles/operation-authority/cordis.patch.yml` while Vardock is stopped, and the Web values in the `--patch` file named below.

| Setting | Value | Where | Reason |
|---|---|---|---|
| `grantExpiresAt` | 7 days after setup | `operation-control` row | Work stops being admitted after one evaluation week unless you renew the grant. |
| `maxOperations` | 1,000 | `operation-control` row | Every model request takes one reservation, so this caps a runaway loop while covering a week of evaluation. |
| `maxFileBytes` | 8 MiB | `operation-control` row | Equals the Assistant's per-file read limit, so the Host and the authority accept the same files. |
| `timeoutMs` | 5 minutes | `execution-container` row | One script, including work-environment startup, may run this long; the package default of 30 seconds is too short for startup plus file processing. |
| `gatewayIdleTimeoutMs` | 5 minutes | `execution-container` row | Equals the script limit, so the gateway does not close an idle connection of a script that may still run. |
| `timeoutMs` | 6 minutes | `operation-control-agent` row of [`cordis.patch.yml`](../cordis.patch.yml) | Exceeds the script limit, so the Host receives the authority's timeout result instead of abandoning the request first. |
| `maxActive` | 2 | `assistant` row of [`cordis.patch.yml`](../cordis.patch.yml) | Each work Session runs its own work environment and model requests; two limit concurrent resource use. |
| `assistant.permissions.data` | all four `true` | `operation-control` row | The [first work request](#try-a-first-work-request) imports an attachment and returns a report without editing configuration. |

To narrow transfers and disclosure, set `import`, `export`, `discloseToModel`, or `discloseToUser` to `false` in `assistant.permissions.data`. Import and export each require both disclosure permissions, and removing `data` denies every transfer.

## Diagnose a problem

Run `pnpm vardock doctor` and follow the reported next action. It checks prerequisites and service listeners. Read effective limits and work outcomes in the entrance UI. With Local Codex, model requests need the Codex login to remain valid; with an API provider, they need the saved key. Starting services does not renew the operation grant.

If startup fails partway through, the command reports the affected service. Use `pnpm vardock stop` to unload jobs belonging to this deployment, resolve the cause, and start again. Completed external effects are not undone by stopping a service.

Private logs are under `$HOME/.vardock/{web,authority,witness}/stdout.log` and `stderr.log`, or the corresponding `--home`. Web's startup URL contains an owner access token. On macOS, the management command does not print it; keep the logs private and do not paste them into public issues without removing sensitive content.

<a id="try-a-first-work-request"></a>
## Try a first work request

Check **Assistant work** above the composer for the grant's remaining reservations and expiry before sending a prompt. Reservations are shared across model requests, shell, broker, file transfers, delegation, and entrance responses. One delegated request with a single external action uses about twenty reservations.

Choose **Try sample** to prepare a CSV and a report request in the empty composer. Review and send it. The conversation sends its model requests to the configured model provider. Scripts run automatically with recorded and witnessed evidence. If setup used `--review-scripts`, check the script in its approval card and select **Allow once**. Open the work’s returned report to preview or download it. [Assistant controls](../README.md#use-this-package)

On macOS and Linux, click the microphone to open first-use guidance, then open **Voice input** under Plugins to choose a recognizer and language and explicitly download and prepare local models; model downloads require an explicit preparation request, including retries.

On macOS, a work Session gets a Linux microVM and private workspace on its first file import or shell command. The guest has only loopback networking. The operation and approval sockets stay on the Host. Files cross into or out of the VM through explicit transfers. The configured model provider receives data disclosed through work results. External business actions are disabled by default.

Use **Usage settings** in the entrance to change the total reservation limit and expiry. Saved limits survive restarts and take precedence over the profile’s initial values. Existing reservations remain counted, and saving does not resume interrupted work. Inspect the work before explicitly continuing; use **Check outcome** for unresolved external operations. Do not remove databases to replenish a budget or clear an unknown outcome.

The [six-stage inventory practice](../../../../examples/practice/README.md) walks through an approved request, witnessed records, outcome confirmation, and automatic reads while updates still wait, without an external service account.

<a id="connect-a-service"></a>
## Connect a service

For a fresh deployment, pass repeatable `--authority-patch /absolute/path/service.yml` and `--permit-action <action-id>` options alongside `--model-provider` and `--model`. Setup composes the patches after its generated authority patch and writes the listed IDs into `assistant.permissions.brokerActions`; without `--permit-action`, the generated list stays empty. A patch that changes only the HTTPS broker needs its complete `operation-broker` configuration, including `routes`; model, expiry, and other authority settings remain setup choices. Unreadable or malformed patches and missing target rows fail setup before profiles are written. The authority validates plugin configuration and rejects unprovided action IDs when it starts; start and doctor point to its private `stderr.log` and authority patch file. The composed profile retains the patches, so source files are not needed at start. A patch’s `config` replaces the row’s entire configuration. [Loader configuration](../../../../docs/cordis-primer.md#loader-configuration)

For a service with a private certificate authority, set `ca: /absolute/path/company-ca.pem` on its HTTPS JSON route or MCP server entry. Only that route or endpoint trusts the PEM certificates; certificate and hostname verification remain enabled. The file must remain readable by the authority. Restart after changing it: its path and content digest identify the route, so saved owner rules for a changed route become inactive, and the next start records the changed configuration with the witness. [Broker CA configuration](../../operation-broker/README.md#private-certificate-authorities)

For “reads automatic, sends reviewed,” configure both broker actions and include both in `assistant.permissions.brokerActions: [read-records, send-message]`. The action names do not decide policy; the owner supplies the rule. This configuration produces:

| Operation | Authority configuration | What the owner sees |
|---|---|---|
| Read records | `unattendedBrokerActions: [{ action: read-records }]`; read route has `returnResponse: true` | No approval card; request and outcome in Business records, with witness evidence. |
| Send a message | `send-message` has no unattended rule | Approval card with the destination and exact saved request; sending waits for the owner's decision. |
| Run a script | `unattendedShell: true`, `backend: apple-vm`, `allowedTargets: []` | No script approval card; recorded execution output and witness receipt. |

Vardock sends an external request only through an action that the authority profile configures and the grant permits. An action is a route of the HTTPS JSON broker, which setup mounts with no routes, or a tool of a remote MCP server. [Broker configuration](../../operation-broker/README.md#use-this-package)

1. Run `pnpm vardock stop`.
2. Open `<home>/authority/profiles/operation-authority/cordis.patch.yml`, where `<home>` is `$HOME/.vardock` or your `--home`. Setup writes JSON by default, or YAML when applying authority patches; the profile loader reads either. It holds one layer whose `insert` list contains the authority's plugin rows, each with an `id`.
3. Add the action as an HTTPS JSON route or an MCP tool, as described below.
4. Add each action ID to `assistant.permissions.brokerActions` in the `config` of the `operation-control` row, for example `"brokerActions": ["example-create"]`. Keep `allowedTargets: []` in the `execution-container` row; the authority refuses broker requests with CONNECT targets.
5. Keep the file private. Start refuses to run unless this file, the `package.json` beside it, and the launchd job files are regular files owned by you without group or other permissions. If your editor changed the mode, run `chmod 600` on the file.
6. Run `pnpm vardock start`. At this start the authority has the witness record the changed configuration and accepts no request until the witness confirms it; meanwhile each request to the authority fails with `configuration-evidence-unavailable`, and `<home>/authority/stderr.log` reports each unconfirmed attempt. If the authority does not become ready, read the same log for the configuration error.
7. Under **Connections** on the Plugins page, enter the action's token. The authority stores it under the action's `credentialRef` and never shows it again. It accepts only bearer-token text.
8. Optionally, add unattended rules for the action on the same page.

To add an HTTPS JSON route, add an entry to `config.routes` in the `operation-broker` row. The broker sends the worker's JSON body with `POST` to `endpoint` and the saved token as a bearer token:

```json
{
  "action": "example-create",
  "description": "Create one item. The body is {\"title\": string}.",
  "endpoint": "https://api.example.com/v1/items",
  "credentialRef": "EXAMPLE_API_TOKEN"
}
```

`action` is the ID that work requests: a lowercase letter followed by up to 63 lowercase letters, digits, `.`, `_`, or `-`. `description` reaches the model verbatim; state what the action does and which JSON body it takes. `endpoint` is a canonical HTTPS URL without user information or a fragment. `credentialRef` names the token with letters, digits, and `_`, not starting with a digit. Optional `returnResponse: true` returns the response text to the worker and therefore to the model, and optional `reconciliationEndpoint` enables read-only outcome lookups. An API that requires request headers beyond `Authorization`, `Content-Type`, and the broker's `User-Agent` cannot be reached by an HTTPS route; use its MCP server if it offers one. [Route fields](../../operation-broker/README.md#example-route)

To call tools of a remote MCP server, add a row to the `insert` list:

```json
{
  "id": "operation-broker-mcp",
  "name": "@deepseek-ai/dsh-operation-broker/mcp",
  "config": {
    "servers": [
      {
        "url": "https://mcp.example.com/mcp",
        "credentialRef": "EXAMPLE_MCP_TOKEN",
        "tools": [
          {
            "action": "example-search",
            "tool": "search",
            "description": "Search items. The body is {\"query\": string}.",
            "returnResponse": true
          }
        ]
      }
    ]
  }
}
```

Then add `operationBrokerMcp` to both lists of the `operation-control` row: its `inject`, so the authority waits for the provider, becomes `["operationBroker", "operationBrokerMcp"]`, and its `config.broker` becomes the same list. `tool` is the tool name as the server lists it; tools the table omits cannot be called. The server must accept Streamable HTTP with a bearer token in `Authorization`; servers that require OAuth or run as a local process are not supported. For example, GitHub documents a remote MCP server at `https://api.githubcopilot.com/mcp/` that accepts a personal access token as a bearer token; this project has not verified it. [MCP tools](../../operation-broker/README.md#mcp-tools)

A profile change changes the grant revision. Approvals and permits not yet consumed stop applying, and work delegated earlier keeps its earlier permissions, so delegate new work to use a new action. A later change to any route or MCP tool also makes the owner's saved unattended rules inactive. [Unattended rules](../../../../SAFETY.md#approval-recovery-and-completion)

## Run the integration test

For the opt-in test with Codex, an Apple VM, and a test-owned loopback HTTPS endpoint, install Chromium using the Web test setup. Run this command from the checkout root after setup has prepared the build and execution image. [Web test setup](../../../../apps/web/tests/README.md)

```sh
DSH_ASSISTANT_REAL_E2E=1 DSH_ASSISTANT_SCREENSHOT_DIR="$PWD/.artifacts/assistant-real" \
  pnpm run test:web:built apps/web/tests/assistant-real.e2e.ts
```

The test uses temporary profiles and your Codex account. It exercises approval, read-only outcome lookup after a lost response, and artifact download. It saves screenshots, the downloaded file, and a receipt summary to the specified directory.

## Remove a deployment

Run `pnpm vardock stop`, then delete the deployment directory, `$HOME/.vardock` or your `--home`. It holds the profiles, launchd job files, logs, Sessions, saved keys and tokens, and the authority and witness databases; deleting it removes every record and cannot be undone.

Apple Container keeps one VM per work Session, named `dsh-vm-<12 hexadecimal characters>-<32 hexadecimal characters>`, with its workspace volume, and the image `dsh-execution:local`, which every deployment on this Mac shares. List them with `container list --all`, `container volume list`, and `container image list`. Remove them with `container delete`, `container volume delete`, and `container image delete`.

<a id="separate-service-accounts"></a>
## Separate service accounts

The management commands target a same-account deployment on macOS or Linux. For a separately administered deployment, provision distinct Web Host, authority, and witness accounts with private homes and operator-owned artifacts. Give the authority account its own model credentials and exclusive access to the execution backend. [Authority and socket ownership](../../operation-control/README.md#use-this-package) · [Evidence witness](../../operation-evidence/README.md#use-this-package)

<a id="linux"></a>
## Linux

Use a trusted Linux account with Node.js 24.9 or newer and its development headers, the checkout's pinned pnpm, `lsof`, systemd user services (`systemctl`, `systemd-analyze`, `systemd-run`, `loginctl`), and Docker. The three services share your user ID. With rootful Docker, `docker` group membership grants root-equivalent host control; a same-user witness process is not independent evidence storage. [Docker access](https://docs.docker.com/engine/install/linux-postinstall/)

Enable lingering so services survive logout and restart after boot. Setup and doctor fail when it is disabled and print the exact `sudo loginctl enable-linger <uid>` command for the owner; they never run sudo. After adding the account to the Docker group, restart its user service manager and reconnect. The diagnostic prints `sudo systemctl restart user@<uid>.service`; this stops all that account's user services. A new shell's group membership alone does not update the manager.

Select a local `unix://` Docker context. Setup and doctor require cgroup v2, memory limits, PID limits, CPU CFS quotas, and the selected runtime among Docker's registered runtimes. They run a transient `docker info` through `systemd-run --user` to check the manager's access.

Linux requires `--runtime` with no default; macOS refuses it. Doctor prints the runtime and its limitations:

| Runtime | Isolation and limits |
|---|---|
| `runc` | An ordinary container sharing the host kernel, not a VM boundary. |
| `runsc` | Uses the gVisor user-space kernel. The PID limit counts sandbox Host tasks, not guest processes. |
| `kata` (`io.containerd.kata.v2`) | Provides a VM boundary in kind and needs KVM; unverified by this project. |

Install and register the runtime first. Kata requires rootful Docker and working KVM. Doctor checks runtime registration, daemon capabilities and service listeners; it does not boot a work container or verify isolation and can pass when a registered runtime cannot boot. Real lifecycle and execution checks covered one arm64 Ubuntu VM with Docker 29.9, runc and runsc. Kata, x86_64, other distributions and rootless Docker remain unverified. Verify startup, reboot and work execution on your intended host.

A real Linux run reported `EXEC_STOP_UNKNOWN` once; it has not been reproduced, and its cause remains unknown. If you see it, the work shows an unknown outcome. Confirm the container has stopped, inspect the work’s workspace result and any outside outcomes in **Business records**, then decide whether to retry the request.

From the checkout root, substitute your provider and model and use the same short private home in every command:

```sh
pnpm install
pnpm vardock setup --home /short/vardock --model-provider openai --model "<model-id>" --runtime runsc --port 3080
pnpm vardock start --home /short/vardock
pnpm vardock doctor --home /short/vardock
```

For Local Codex, sign in with `codex login` as the deployment account and substitute `--model-provider codex-local --model default`. Save API keys through **Connections** after startup. Setup builds the checkout and a missing `dsh-execution:local` image with `docker build -t dsh-execution:local packages/experimental/execution-container`. The authority's Docker row includes its socket, runtime, gateway socket, image, and the same five-minute execution and gateway timeouts. [Model provider](#choose-a-model-provider) · [Default grant](#default-grant)

Setup writes mode-0600 units `io.github.virtualhatch-inc.vardock.{witness,authority,web}.service` in the home and pre-creates private logs with mode 0600. Start uses `systemctl --user enable --now <absolute-unit-path>` in witness, authority, Web order, waiting for readiness after each. Units restart exited processes after 30 seconds and start with `default.target`; `After=` alone does not wait for application readiness after reboot. Fixed names allow one deployment per user; another home's loaded units are refused.

Linux start prints the authenticated Web URL without opening a browser; `--no-open` remains accepted. The URL and logs contain the owner access token: keep them private. For remote access, forward the same local port, for example `ssh -N -L 3080:127.0.0.1:3080 user@host`, then open the printed `http://127.0.0.1:3080/?token=…` URL locally. Keep the same host spelling and port: the browser cookie is bound to them.

To remove a deployment, run `pnpm vardock stop --home /short/vardock`, which disables and stops Web, authority, then witness. Stop waits for systemd to finish each shutdown under the unit’s `TimeoutStopSec`. Delete that home only when its saved work, credentials, grants, and evidence records are no longer needed. Docker work containers, workspace volumes, and the shared image remain. Inspect with `docker ps --all`, `docker volume ls`, and `docker image ls`, and remove only resources you have identified as disposable.

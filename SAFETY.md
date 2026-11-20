# Safety

English | [日本語](SAFETY.ja.md) | [中文](SAFETY.zh.md)

By default, Vardock runs routine scripts automatically in a work environment without direct external networking and records and witnesses every operation. The authority asks the owner at key points determined by fixed rules, never by a model: an external business request waits unless an owner rule admits it; notes and schedules still require approval.

## Experimental status

Vardock and its DeepSeek Harness foundation are developer-preview software. Vardock has not undergone an independent security audit and must not be treated as production-ready or as the sole security control for untrusted workloads.

The system can execute model-generated code, load plugins, and use the files, credentials, processes, and network access available to its components. Defects, misconfiguration, malicious input, or untrusted plugins can damage files, disclose information, spend resources, or cause unintended external effects. Back up accessible data and use only the access needed for the task.

<a id="mediation-and-isolation"></a>
<a id="threat-model"></a>
## Threat model

In the default macOS and Linux setup, the Web Host (entrance and workers), operation authority and witness are three processes under the deployment account. Separate processes and databases do not prevent that account, or another process under it, from changing records, configuration, credentials or approvals. Administrative independence requires separate accounts and operator-owned code, storage and sockets. [Separate service accounts](packages/experimental/assistant/vardock/README.md#separate-service-accounts)

The authority binds work to a principal and permission set, retains each proposed operation, obtains a witness receipt, and checks the current grant before execution. It decides model requests, scripts, broker requests, file transfers, delegations, and entrance responses, and records each one with its outcome. Human approval covers the saved script or request only; it cannot add permissions. When a start brings a changed configuration, the authority accepts no request until the witness records the configuration in effect: the permission ceiling, the permitted broker actions, the unattended settings, the model route, the execution backend, and the initial limits. That record does not contain the profile file, a profile edit undone before the next start, or the Host and Web profiles. [Operation authority](packages/experimental/operation-control/README.md)

On macOS, the work environment is an Apple Container Linux VM with only loopback networking and the configured gateway path to the authority. Broker routes fix external destinations, and the authority retains service credentials. Direct host execution or an alternate execution provider does not inherit these settings. [Apple VM provider](packages/experimental/execution-container/README.md)

On Linux, Vardock setup configures the Docker execution backend and builds a missing execution image. The work environment is a Docker container with no network device other than loopback, a read-only root, a non-root user, no capabilities, memory limits and a runtime-dependent PID limit. Its configured communication path is broker-only: requests admitted by the authority travel through a relay over `docker exec` standard streams to the gateway. The script can stop, replace or impersonate that relay; the Host pump and gateway check each request. These controls are not proof against kernel compromise. runc is an ordinary container sharing the host kernel, not a VM boundary; a host-kernel compromise is not limited to the daemon account. runsc (gVisor) uses a user-space kernel; its PID limit counts sandbox Host tasks and does not bound guest processes. A functioning Kata deployment provides a VM boundary in kind and needs KVM, but this project has not verified it. Rootful Docker access grants root-equivalent Host control. In a single-account deployment, that account holds authority credentials, records and the witness. Linux verification covered one arm64 Ubuntu VM, Docker 29.9, runc and runsc. Kata, x86_64, other distributions and rootless Docker are unverified. [Docker provider](packages/experimental/execution-container/README.md#known-limitations-and-deferred-work)

The authority does not cover:

- The model context. Each model request sends its allowed context, including data disclosed from work results and external service responses returned to work whose grant allows `returnResponses`, to the configured model provider. Work-environment network restrictions do not make model use offline.
- What an admitted script does inside its own work environment and workspace, and the CPU, memory, and time it consumes there within the configured limits.
- Changes made by your OS user or by a process running as that user.
- What a broker destination does with a request it receives, and the content of its response.
- Anything a trusted Host component does: the Agent Host, installed plugins, operator configuration, the model adapter, and the container management service. The work environment does not isolate these components.

Voice model preparation runs on the Host outside the operation authority and downloads model files from Hugging Face and its download services. Model downloads require an explicit preparation request, including retries. With the bundled local recognizer, audio passes from the browser to the Host and its local recognition process; no audio is sent to an external speech service.

`pnpm vardock verify` runs while Vardock is running. It reads every witness event and compares each operation event and the current configuration record with the authority's receipt, so it detects an operation record the authority no longer has, a receipt that differs from the witness's event, and a current configuration the witness never recorded. It does not report another authority record that the witness never received, does not compare grant limit, rule, credential, lookup, or earlier configuration events, and cannot detect a change made by someone who controls both databases, which in this setup is your OS user. If the authority's configuration record is still unconfirmed, the first privileged request, which verify makes, finalizes it once the witness confirms it; otherwise verification changes nothing. [Evidence witness](packages/experimental/operation-evidence/README.md)

Keep model credentials and broker tokens outside work inputs and repositories. Keys and tokens saved under **Connections** on the Plugins page are stored by the authority and are not shown again.

The generated profiles disable DSH telemetry. Other inherited profiles have their own telemetry settings; review them before switching profiles. This does not disable model-provider requests. [Session telemetry](packages/session/session-telemetry-otel/README.md)

<a id="approval-recovery-and-completion"></a>
## Approval, recovery, and completion

Read the exact script, destination, body, and attachments before approving. A shell approval is not blanket approval for external business operations. Each broker operation requires its own approved stored request within the configured work permissions, unless an unattended rule admits it. For MCP tools, the saved JSON body is serialized from the validated arguments and can differ from the requester's text. A scheduled task repeats its prompt to the Assistant without further input, so the Assistant creates, changes, or deletes one only after you approve its exact content; no unattended rule covers that decision. Assistant notes are model-written text that later entrance requests carry; they grant no permissions, and the Assistant saves them only after you approve their exact text.

Unattended rules remove the human decision, not the record: `unattendedShell` admits every shell script, and `unattendedBrokerActions` admits requests to a listed action, optionally only when top-level body fields equal configured values. A rule with `match` requires an `allow` list of the other top-level fields a request may contain; `allow: []` permits no other fields. The values of listed fields are not checked. A rule with neither `match` nor `allow` covers every body of its action. A route that returns its response gives the service’s response text to the worker’s script and therefore to the model. The owner can change an action’s rules under **Connections** on the Plugins page; a model or work environment cannot, and `unattendedShell` can be set only in the authority profile. From the owner’s first change, the owner’s rules replace the profile’s rules. The owner’s rules of each action are bound to that action’s route: where its requests go, what comes back, and the provider limits that change either. After that route changes, the action’s saved rules stay stored but inactive, and every request for that action waits for a decision until the owner saves rules for it again, starting from an empty list, or until the route is again exactly as it was when the owner saved them. Rules of other actions stay in effect. Enable these only for destinations and content you would approve every time.

An interruption can leave an operation `unknown`: an external effect may have happened even when the response was lost. Vardock retains this state and does not automatically resend the operation. No rule admits a request to the same action as an earlier request whose outcome is unresolved; that request waits for your decision. Its approval card names the earlier operation and warns that approving may repeat its effect. A worker’s completed report does not close its work while one of its external requests has an unresolved outcome; the work shows an unknown outcome instead. Use the configured read-only outcome lookup or inspect the external service before creating another operation. On Business records, record what you checked with **I checked: it happened** or **I checked: it did not happen**; the determination releases that operation’s hold only after witness confirmation, and the row names the owner as its source. Do not delete the authority database to clear uncertainty or replenish a budget.

Imported-file work cannot be reported complete unless a nonerror exec result was observed in that work. This does not verify that the files were read or that the reported results are accurate.

A witness receipt confirms retained evidence. An Agent’s completion report, a process exit code, a response-release receipt, and a verified business outcome mean different things. External completion is determined by the configured provider’s lookup evidence or the owner’s witnessed check; release of an entrance response does not prove that the browser or user received it.

<a id="local-operation-and-reports"></a>
## Local operation and reports

Keep the development UI on loopback. The URL’s access token grants access: do not publish it, logs containing it, runtime directories, Session databases, or credentials. This setup is not a multi-user internet service. Do not expose it through a public tunnel without a separately reviewed authentication and deployment design.

For a suspected vulnerability, avoid public issues containing credentials, private conversations, or an actionable exploit. Report it privately as described in [Security](SECURITY.md). No dedicated security response service or response-time commitment is provided.

## No warranty or liability

Use Vardock at your own risk. The software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for damage, loss or disclosure of data, or other harm arising from use.

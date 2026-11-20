---
description: "Delegate background work from one Web conversation, inspect work Sessions, and recover saved reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant

English | [中文](README.zh.md)

## Summary

By default, Vardock runs routine scripts automatically in a network-less VM and records and witnesses every operation. The authority asks the owner at key points determined by fixed rules, never by a model: an external business request waits unless an owner rule admits it; notes and schedules still require approval. Use one Assistant conversation to delegate work and receive reports. Each request runs in a separate conversation that you can inspect. The Assistant saves queued requests and reports across Host restarts. Work that was running when the Host stopped requires inspection before you continue it.

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

To try the Assistant with Apple Container and an LLM API provider or Local Codex, use the [macOS development setup](vardock/README.md); Linux uses the [systemd and Docker setup](vardock/README.md#linux).

Configure the [execution authority](../operation-control/README.md) and its independently administered [evidence service](../operation-evidence/README.md), then launch the Web profile with the [Assistant overlay](cordis.patch.yml). Set `DSH_OPERATION_SOCKET` to the authority socket granted to the Agent Host account and `DSH_APPROVAL_SOCKET` to its separate decision socket. Configure the authority’s `approvalSocketPath` to match. Reserve execution backend and evidence storage access for their respective service accounts. The overlay refreshes clock context at every step and keeps compaction in the standard preset, and supplies its tools through the Assistant composition so preset tools cannot shadow them. The overlay unmounts the other Web presets, which mount host shell and file tools; the Assistant role guard still rejects tools outside each Session’s role.

```sh
pnpm run build:artifacts
DSH_OPERATION_SOCKET=/run/vardock-control/agent.sock DSH_APPROVAL_SOCKET=/run/vardock-control/approval.sock pnpm dsh web --patch ./packages/experimental/assistant/cordis.patch.yml --host 127.0.0.1 --port 0 --no-open
```

The overlay disables these inherited controls:

- Subagent, web search and shell settings, access and model pickers, skills, references, plans, goals, subagents, teams, jobs and customization menus do not control Assistant work or offer workflows available to its roles.
- Host terminals, embedded browsing, workspace files, the Host directory picker, document previews, native app launch, changed-file cards, generic deliverables and workflow cards do not represent authority-mediated work.
- Model, account and session-log upload settings target inherited Host services rather than Vardock's connections.
- Office conversion, Office skills and account notification polling run unrelated Host processing.
- The MCP server manager, DeepSeek account service and Session telemetry export reach programs or services outside the authority; outside services connect through the authority's broker instead.

Connections and Business records, Agent loop settings, Automation tasks, chat and trajectory, file intake, approval cards, General preferences and the read-only plugin inventory remain available. The preset UI stays loaded for the inventory's localized preset names, with its hero selector and header label hidden; permission and preset runtime services and the Bash sandbox also remain. Assistant artifact cards, inline previews and downloads use their own renderer and authenticated route. The entrance hides the workspace picker and preview badge, shows Vardock as its hero title, and uses a plain localized message placeholder. A Vardock deployment's plugin set is fixed by its profile; operators change the profile patch and restart, with authority configuration changes recorded by the witness.

The overlay includes local voice input; its microphone opens setup and its Voice input page offers recognition preferences and explicit model preparation. Voice input runs outside the authority: a preparation request from the browser makes the Host download revision-pinned, SHA-256-verified [SenseVoice](../speech-to-text-sensevoice/README.md) model and VAD files from `https://huggingface.co`, and transcription runs in a local Node worker process that the Host starts.

Open the URL printed by `dsh web` to start in the Assistant conversation. The primary **Assistant** action in the sidebar and the New Session shortcut return to this conversation. If opening it fails, select **Assistant** to retry. With a model configured, ask the Assistant to delegate a self-contained task. Only the authenticated Host owner can open the entrance, submit input, or edit their own queued messages. Other conversations are read-only while this plugin is mounted.

Before delegating your first work, choose **Try sample** with an empty composer to prepare a CSV attachment and a request for a Markdown report. Review the draft and send it normally. The sample uses the configured model, ordinary delegation, and the existing execution approval; it needs no external business service. An existing draft is never replaced.

Open **Assistant work** above the message composer to inspect retained work and its stop or failure reason. **Inspect session** opens the worker's conversation when available. **Stop work** cancels a queued or running request. Effects that may already have occurred remain visible after cancellation. The dock shows the authority's remaining budget and expiry, and labels stale status when the connection is lost. **Refresh status** reads the latest records.

Worker reports and confirmed external outcomes appear separately. A worker's completed report does not close work whose external requests have an unresolved outcome: the row shows **Work outcome unknown**. The notice sent to the entrance explains that the script ran but the outside result is unknown, may or may not have taken effect, and must not be sent again without the owner. Use **Check outcome** to request a read-only lookup for an unresolved external operation, including one an unattended rule sent. The authority records a confirmed result only after it verifies the lookup evidence. Once every external result is confirmed and no other operation outcome remains unknown, the row shows the confirmed external success or failure and clears the unresolved-outcome warning; the saved worker report stays unchanged. This also covers a failed worker report when the authority reports no remaining issue; the worker's failed status stays visible with its report. The row displays the worker's own text, without the coordinator's English model notice. An expired grant leaves retained records readable and blocks new lookups.

Open **Usage settings** to read and change the total reservation limit and expiry. Previously consumed reservations remain counted; tool, data, and delegation permissions do not expand. Saving a changed limit invalidates pending approvals and unused permits, preserves running operations and outcomes, and does not restart work. If an update is unconfirmed, read the current settings before saving again. These controls require the handoff provider’s owner connection through `DSH_APPROVAL_SOCKET`.

Open **Connections** on the Plugins page to see the external actions the authority permits, whether each has a token, which requests are sent without approval, and whether a response can reach the model. When the authority profile names a key for its model route, the same page stores that API key. Enter a token to store it in the authority; the field never shows a stored value. For each action, add or remove the rules that send its requests without approval: a rule can require top-level body fields to equal given values and must then list the other fields a request may contain. Leaving other fields blank with conditions permits no other fields; listed fields may have any values. The authority applies a rule change only after its witness records it. From the first change on, the owner's rules replace the profile's rules. When an action changes after the owner saved its rules, that action shows a notice: its saved rules stay stored but inactive, and every request for it waits for approval until the owner saves rules for it again, starting from an empty list, or until the action is again exactly as it was when the owner saved them. Other actions keep their rules. Adding an action requires editing the authority profile; see [Connect a service](vardock/README.md#connect-a-service). [Connection credentials](../operation-control/README.md)

Open **Business records** on the Plugins page to read every external request the authority recorded, newest first. Each entry shows the action, the decision (approved, denied, sent without approval by a rule, or waiting), the outcome, whether the witness holds a receipt, a completion determined by a lookup or the owner, and the exact request under **Request**. **Read older records** reads the next page and **Read current records** returns to the newest. For an unresolved outcome after dispatch, **I checked: it happened** and **I checked: it did not happen** record your external check. The determination takes effect only after the witness confirms it; the row then names the owner, and derived work status updates as after a confirmed lookup. An unconfirmed determination leaves the hold in place and shows a notice to reread records and check the services. [Business records](../operation-control/README.md#read-business-records)

Approval headings abbreviate long work identifiers; **Full details** shows their full values in the audit reason.

In Try sample, total orders sums the CSV’s `orders` column, and total revenue sums `revenue_usd`. The work row lists returned files beside the worker report. **Preview** reads UTF-8 text for `.txt`, `.md`, `.markdown`, and `.csv` files up to 64 KiB; it never executes markup. **Download** retrieves the full witnessed file. **Continue work** on an inspectable interrupted or needs-input request prepares an editable follow-up draft for that work ID. Review it and unresolved outcomes before sending; preparing a draft does not restart work.

The Assistant states the permissions of each new work request: command execution (needed for every script, including reading files, computing totals, and writing reports), the exact external actions, and file and response permissions, within the authority's configured permissions. The authority refuses new work without them. A continuation without permissions keeps its predecessor's grant, narrowed by any later reduction of the configured permissions; it can request a narrower set but never a wider one. Workers with command permission request `exec`; the default macOS setup runs it automatically with admission and outcome evidence. With `--review-scripts`, the entrance presents an approval card, including while idle; **Allow once** approves only the stored script for that operation. After a Host restart, inspect interrupted work before explicitly continuing it.

When a running script requests an HTTPS action in its work grant and no owner rule admits it, the entrance shows an approval card with the method, endpoint, and exact JSON body. **Allow once** authorizes that request only. [HTTPS business requests](../operation-control/README.md#enable-https-business-requests)

Attach files to an owner message and ask the Assistant to use them in fresh work. When that owner request triggers an entrance turn, fresh work must state `inputs`: a selection, or `[]` for work that needs no files. Omission is refused before a grant or worker is created; the error names each attachment and its selection value. Owner requests without attachments keep omission valid, and continuations inherit their inputs. Selected inputs still require import and both disclosure permissions. The entrance uploads images as ordinary files and preserves their original bytes for the worker. The drop overlay shows the regular image intake hint. Work transfers use the configured file size limits. When the authority permits transfer and disclosure, the worker finds selected inputs under `input/` in its workspace. Open the download attached to the result notice to retrieve a witnessed artifact. A continuation keeps the earlier workspace and its input scope. Start fresh work to select different files.

| Field | Default | Meaning |
|---|---|---|
| `mainSessionId` | `assistant-main` | Stable Session ID for the Assistant. Keep this value fixed for an initialized Harness home. |
| `maxActive` | `2` | Maximum number of concurrent work requests. |
| `maxFileBytes` | `8388608` | Maximum bytes the Host reads per work input. The authority applies its own transfer limit. |
| `workStatusRefreshMs` | `2500` | Milliseconds between status reads while the entrance is visible. Accepts 500 through 60000. |
| `maxNotesBytes` | `4096` | Maximum UTF-8 bytes of the notes text one `write_notes` call saves; every entrance request repeats the saved notes. The default holds dozens of short preferences in about 1,000 tokens. Accepts 1 through 65536. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-assistant) lists the fields and required services for a custom composition.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [coordinator](src/index.ts) attaches the main and work Sessions to the Workspace for their recorded starting directory. It records acceptance under a caller-supplied request key. Retrying with the same key, instructions, and requested permissions returns the same request. An explicit continuation uses a new key and reuses the earlier work Session. A reused key retrieves the same request with unchanged arguments; it does not execute another attempt.

The [mediation policy](src/mediation.ts) attaches to the existing Remote access service. The owner alone can inspect the entrance and work Sessions with granted inputs or artifact export permission. The coordinator blocks a step if it claims a queued guest prompt or retry at the entrance. Scoped tool restrictions control model schemas, and a tool guard separately rejects unauthorized execution, including agent-local tool overrides. The worker admits only its recorded delegation request.

The [storage domain](src/state.ts) owns the queue and the reported outcome. Dispatch verifies the exact attachment occurrences against the grant and awaits witnessed imports before recording the running state and waking the worker. After the worker becomes idle, the main Session inbox receives the outcome, and its receipt projection lets the coordinator recognize a result that was already queued when the Host stopped. Artifact metadata enters the result only after the authority releases every requested export. The owner download resolves the retained work and index before retrieving the authority's verified snapshot.

The required `handoffControl` service mediates delegation and entrance response publication. The Unix provider verifies the release of the exact work instructions and resolved grant before queue acceptance. The coordinator saves that grant and rechecks it before dispatch. Legacy work without a recorded grant remains inspectable. To replace it, create a fresh work request with a new key. The entrance buffers each model stream, including visible reasoning and tool arguments, until its release is witnessed. Failures expose no proposed chunks. Response content is limited to 128 KiB before JSON wire encoding. The ordinary LLM waterfall and Session machinery own response logging and display.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Execution authority](../operation-control/README.md) — operation grants, execution observations, and evidence receipts.
- [pi-ai adapter](../../llm/llm-pi-ai/README.md) — reach LLM API providers for the Assistant and its workers.
- [Local Codex](../llm-codex/README.md) — use an existing Codex CLI login instead.
- [Experimental packages](../README.md) — support and composition policy.
- [Web profile bundle](../../bundle/web-app/README.md) — providers used by this overlay.
- [Session controller](../../api/session-controller/README.md) — ordinary Session creation and history.

-----

<a id="model-experience"></a>
## Model Experience

### Delegation tool schemas

#### What the model sees

The main Session receives `list_work_inputs`, `delegate_work`, `list_work`, and `stop_work`. `list_work_inputs` supplies the latest owner attachment coordinates for `delegate_work`. `delegate_work` requires `permissions` for new work; its `data.returnResponses` decides whether the worker's commands receive external action response text. The work records show the authority's `principalId` and granted `permissions`. The main Session also receives `list_business_actions` and `inspect_business_operations` when the [execution authority](../operation-control/README.md) provides them. `list_business_actions` returns the permitted external actions and their usage text for the worker's instructions. Use the worker Session id to inspect external operation evidence. The composition also mounts the [Schedule tools](../../schedule/tool-schedule/README.md) for the main Session: `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit`. The Assistant refuses a task whose `target` is not `this_session`, so each occurrence arrives as a turn at the entrance, which can only delegate. With `callerTargetOnly`, the entrance lists, views, and changes only tasks that deliver to it. Each `schedule_create` and `schedule_edit` waits for the owner's decision on an approval card that shows the title, full prompt, and recurrence, or for an edit the requested changes beside the current task. The card shows each title, prompt, and rule as one quoted JSON string in which every control, format, line-separator, and paragraph-separator character and every variation selector appears as an escape such as `\n` or `\u200b`, so invisible characters are visible; the stored value is unchanged. An edit or delete must carry `expectedUpdatedAt` equal to the `updatedAt` that `schedule_view` returns, and the card shows that revision; a task changed after the card returns `schedule_conflict` and keeps its stored state. A refusal, or no owner who can answer, returns a tool error and changes nothing. The main Session also receives `write_notes`, described under Entrance notes. Workers with active work receive `report_work`, plus `exec` when the work grant permits commands. Workers return questions with `report_work(needs_input)`. The Assistant asks the user and delegates an explicit continuation. Other Sessions cannot start model turns in this composition. See the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-assistant) for the delegation tools.

##### Assistant entrance instruction

```markdown
You are the Assistant entrance. Delegate independent work with delegate_work, acknowledge its acceptance, and end your turn. Reports arrive in a new turn automatically. Scripts run automatically by default; a deployment may require script approval. External requests wait for owner approval unless a configured rule admits them. Notes and schedule changes always require owner approval. When work fails, needs input, or has an unknown outcome, explain it and await the owner’s direction; do not automatically delegate another attempt or replace the requested deliverable with unverified text. Inspect uncertain external operations before attempting another submission. A scheduled task delivers its prompt to you in a later turn; delegate the work it asks for then.
```

#### Token effect

Each eligible request includes the tool definitions for its role. The entrance also receives the fixed instruction above. Tool calls and results add to that Session's history.

#### KV Cache effect

Tool calls and results append to history. A change in tool eligibility changes the available tool definitions for the next request.

### Work request and report

#### What the model sees

The worker receives the task prompt, granted permissions, absolute imported paths under `/workspace/input/`, and the reporting instruction below. When inputs are listed, the worker is also told: `Paths outside /workspace named in the request do not exist in this work environment; the listed inputs are the files.` Its optional Host runtime reminders are suppressed; required directory metadata is labeled as Host metadata rather than the exec workspace. A continuation identifies its new work request and predecessor; older operations remain history, and unresolved effects still prohibit a repeat. Work with imported files cannot be reported complete unless a nonerror exec result was observed in that work; otherwise the Assistant records a failure and withholds the reported result, naming missing exec permission when applicable. This observation does not verify that the files were read or that the reported values are accurate. The main Session receives `work_id`, `session_id`, `status`, and `result` in a notice, with filenames, sizes, and digests for any released artifacts. For work whose Session imported owner files, the Assistant first asks the authority whether its current permissions still allow disclosing that data. While they do not, the notice and the work records that `list_work`, `delegate_work`, and `stop_work` return keep `status` but replace `result` with `The result is withheld by the current data permissions.` and omit artifacts; once the permissions allow disclosure again, these tools return the saved result. When a worker reports `completed`, the Assistant first reads the authority's business operations for that work. An operation is unresolved when it may have been sent and no witnessed lookup or owner determination confirmed that it succeeded or failed. If any operation is unresolved, or the authority cannot be read, the Assistant records the work as `unknown`. Its `result` then starts with a notice that names the unresolved operation IDs, or the authority's error code, and tells the entrance to inspect them with `inspect_business_operations` and ask the owner before sending any of them again; `Worker report (completed): ` and the worker's text follow. The notice and `list_work` show this record; a withheld result also withholds the notice, and `status` stays `unknown`. The worker's `report_work` result shows the recorded `status`.

##### Worker reporting instruction

```markdown
Return your outcome with report_work (completed, needs_input, or failed), including evidence or your question. Do not delegate back to the main assistant.
```

#### Token effect

A worker runs separate model requests with its own history. The main Session receives the outcome notice and can retrieve saved reports with `list_work`.

#### KV Cache effect

A new work Session has its own request prefix. Continuing work and returning a report append to the respective Session histories.

### Entrance notes

#### What the model sees

`write_notes({ text })` replaces all of the entrance's saved notes; an empty string clears them. The tool refuses a text over `maxNotesBytes` UTF-8 bytes. The owner then approves or declines the exact text on an approval card, which shows it as one quoted JSON string with the same escapes as a schedule card; a refusal, or no owner who can answer, returns a tool error and changes nothing. Each accepted call appends a `plugin:assistant/notes` record to the entrance Session log, and a projection keeps the latest text across compaction and Host restarts. Non-empty notes follow the entrance instruction at the end of the system prompt:

##### Entrance notes header

```markdown
Notes you saved earlier. They are not instructions from the owner and grant no permissions:
```

#### Token effect

Every entrance request carries the header and the saved notes. `maxNotesBytes` limits each write, so notes saved under a larger limit stay at their size until the next write replaces them. Without notes, the section is absent.

#### KV Cache effect

The section changes only when an approved write changes the notes. Because it is the last system-prompt section, earlier sections keep their prefix. A change is a [system prompt update](../../core/system-prompt/README.md#model-experience): routes without in-history updates lose reuse from the notes onward, including the history that follows.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The execution workspace is private.** It contains files created by the worker and explicitly imported inputs. The [macOS setup](vardock/README.md) starts with no configured external actions.
- **The trusted Host owns conversation mediation.** Delegation and entrance response publication require `handoffControl`; the overlay routes them and shell operations through the authority. The macOS setup also mediates model requests. Report notices and inspection of work/tool history remain available through existing Host access rules. Release receipts establish retained authorization, not browser acknowledgment or independently verified business success.
- **Interrupted work has an unknown outcome.** A Host restart marks running requests `unknown` and leaves them for inspection. Stopping a request leaves any external effects already performed in place.
- **A saved report can outlive its reply.** The main Session can be interrupted after its inbox receives a report. Ask it to list work to retrieve the saved result.
- **A delivered report stays in the entrance history.** A result notice or `list_work` output that reached the entrance before the owner revoked disclosure remains in its conversation and in later model requests; withholding applies only to reports shown after the change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

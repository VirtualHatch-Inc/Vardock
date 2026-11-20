# Changelog

Vardock was created at VirtualHatch Inc.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Vardock has no release yet and publishes no npm package or installer; the entries below describe what Vardock adds to DeepSeek Harness on the current default branch.

## Unreleased

### Added

- Delegation and entrance tools: one Assistant entrance conversation delegates requests to worker Sessions, reports results, and, after the owner approves each change, schedules recurring work and keeps notes. Local Codex is available as a model provider.
- Operation authority and approvals: a separate authority process admits, reserves, and records model requests, scripts, broker requests, file transfers, delegations, and entrance responses under a grant. Each script or external request waits for the owner's approval unless an unattended rule admits it.
- Execution: shell, Node, and file processing run in a per-Session Apple Container Linux VM without network access.
- Witness and record comparison: a witness process stores each fact the authority reports, including credential changes, and returns a receipt; `pnpm vardock verify` compares the witness's events with the authority's receipts.
- Connections, rules, and records pages: the owner saves action tokens and the model API key, edits unattended rules, and reads the authority's business records from the Plugins page.
- HTTPS and MCP brokers: configured HTTPS JSON routes and operator-selected tools of remote MCP servers become actions; the authority holds their tokens and can return a route's response to the requesting script.
- Model routes: the authority's model route can name any mounted LLM provider, and the Host reaches it without the model credential.
- macOS lifecycle commands: `pnpm vardock setup`, `start`, `stop`, `doctor`, and `verify`.

### Known limits

- macOS 26 or later on Apple silicon only; no independent security audit.
- The authority, witness, and Host run as the same OS user, so that user can change records, configuration, credentials, and approvals. See [Safety](SAFETY.md#threat-model).
- An interrupted operation can remain `unknown`; Vardock does not resend it automatically.

# Security policy

English | [日本語](SECURITY.ja.md) | [中文](SECURITY.zh.md)

## Supported versions

Vardock is developer-preview software with no releases. Only the current default branch is supported; reports against older commits are assessed against the default branch.

## Report a vulnerability

Report a suspected vulnerability through GitHub private vulnerability reporting: open the repository's **Security** tab and select **Report a vulnerability**, which opens <https://github.com/VirtualHatch-Inc/Vardock/security/advisories/new>. The form is available only after the repository is public and the maintainers have enabled private vulnerability reporting. If it is not available, open an issue that asks the maintainers for a private channel and contains no vulnerability details.

Do not open a public issue containing credentials, private conversations, or an actionable exploit.

## What to include

- The affected package or command and the commit you tested.
- The macOS, Apple Container, and Node.js versions, and the model provider route, without its key.
- The steps to reproduce, the expected and observed results, and the impact.
- The access an attacker needs, for example a local OS user, a model response, a broker destination, or a work VM.

Remove access tokens, API keys, Session content, and private inputs from logs and attachments.

## Response

No response time, fix date, or dedicated security response service is promised.

## Threat model and limits

[Safety](SAFETY.md) describes the threat model, what the operation authority does not cover, and the limits of record verification. A report that depends on control of the OS user that runs Vardock describes a documented limit of the macOS development setup.

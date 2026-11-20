# Contributing to Vardock

English | [日本語](CONTRIBUTING.ja.md) | [中文](CONTRIBUTING.zh.md)

Vardock is an independent customization of DeepSeek Harness. Discuss Vardock behavior and proposed changes in this repository; do not send Vardock-specific support requests to the upstream DSH maintainers. Participation follows the [Code of conduct](CODE_OF_CONDUCT.md).

## Report a problem

Include the affected component, operating system, versions, minimal reproduction, expected behavior, and observed result. Remove access tokens, credentials, private inputs, and Session content from logs. Follow [Safety](SAFETY.md#local-operation-and-reports) for sensitive reports.

## Make a change

Keep changes small and reuse DSH services and Cordis extension points. Read [AGENTS.md](AGENTS.md), the [architecture](docs/architecture.md), and the [development guide](docs/development.md). Update the owning documentation and its language pair when behavior changes.

Run checks appropriate to the changed component and report the commands and results. The [testing guide](docs/testing.md) describes unit, snapshot, provider, and build checks. Do not include runtime homes, local credentials, database contents, or generated build products in a contribution.

Preserve upstream copyright, license notices, and attribution. Source contributions use this repository’s [MIT License](LICENSE); disclose additional dependencies and the redistribution terms of any artwork or other supplied material.

## Distribution

The supported evaluation path is the [source-based macOS setup](packages/experimental/assistant/vardock/README.md). Inherited npm, desktop, Python, and website publishing scripts target DSH infrastructure and require a separate Vardock release configuration and redistribution review. A repository source release does not by itself authorize redistribution of every bundled dependency.

## Versions

A Vardock version is an annotated Git tag on the public repository named `vardock-vMAJOR.MINOR.PATCH`, or `vardock-vMAJOR.MINOR.PATCH-rc.N` for a release candidate; another repository pins Vardock by that tag. The `dsh-v*` tags mark upstream DSH releases, not Vardock versions. The root `package.json` keeps the upstream DSH version because [workspace constraints](scripts/check-workspace-constraints.ts) require every `@deepseek-ai/dsh*` package to carry the root version. Each tag message names the upstream release that the version is based on, for example `Based on dsh-v0.2.2-rc.2`.

To install Vardock at a tag, clone the repository at that tag, run `pnpm install --frozen-lockfile`, and run `pnpm vardock setup` with a model route as in the [macOS setup guide](packages/experimental/assistant/vardock/README.md). Keep the checkout in place: the generated profiles reference its built packages.

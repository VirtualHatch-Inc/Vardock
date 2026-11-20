---
kind: upgrade-guide
description: "Fresh Vardock setups run scripts automatically unless review-scripts is selected."
---

# Automatic scripts in Vardock setup

English | [中文](guide.zh.md)

## Change

`pnpm vardock setup` writes `unattendedShell: true` in the authority profile. Previously each script waited for approval. Scripts run in the network-less work environment; admission and outcome evidence are still recorded and witnessed. Business requests wait for approval unless an owner rule admits them. Notes and schedules still require approval. Existing deployments are not rewritten.

## Migration

1. For a fresh deployment that reviews every script, add `--review-scripts` to your existing setup command, alongside `--model-provider` and `--model`.
2. To switch an existing deployment to automatic scripts, run `pnpm vardock stop`, then set `unattendedShell` to `true` in the `operation-control` row's `config` in `<home>/authority/profiles/operation-authority/cordis.patch.yml`. Keep the configured execution backend: `backend: apple-vm` with `allowedTargets: []`, or `backend: docker` with `gatewaySocket`. Set `unattendedShell: false` to review every script instead. Keep the file private with mode `0600`.
3. Run `pnpm vardock start`. The authority records the changed configuration with the witness before admitting requests. Run `pnpm vardock verify` to compare the current configuration and operation evidence. With automatic scripts, a script has no approval card; a business request without an owner rule still has one.

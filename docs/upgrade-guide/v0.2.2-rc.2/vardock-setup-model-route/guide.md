---
kind: upgrade-guide
description: "`pnpm vardock setup` requires `--model-provider` and `--model` and no longer selects Local Codex when both are omitted."
---

# Vardock setup requires a model route

English | [中文](guide.zh.md)

## Change

`pnpm vardock setup` without `--model-provider <route> --model <id>` used Local Codex. It now stops before changing anything and lists the routes: an LLM API provider route of the pi-ai adapter with its model ID, or `codex-local` with model `default` for Local Codex. This affects scripts and instructions that run setup without both options. Deployments that already exist are unaffected.

## Migration

1. For Local Codex, replace `pnpm vardock setup` with `pnpm vardock setup --model-provider codex-local --model default`, keeping any `--home` and `--port`. The Codex login check still applies to this route.
2. For an LLM API provider, pass its route and model ID instead, for example `--model-provider openai --model "<model-id>"`, and after the first start save the key under **Connections** on the Plugins page.
3. Confirm that setup prints `Prepared Vardock in <home>.`

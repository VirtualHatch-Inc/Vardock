---
description: "Use an existing local Codex CLI login for DeepSeek Harness model requests without setting an API key in Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex

English | [中文](README.zh.md)

## Summary

Use your local Codex CLI login to answer text requests in Harness. The Web Assistant can delegate work and receive reports using the same model route for the main Session and its workers. Codex handles authentication; you do not enter an API key in Harness. Requests use your Codex account's limits.

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

From the environment that runs the Harness Host, check that `codex` is available and `codex login status` reports your ChatGPT login. If you are signed out, run `codex login` and select ChatGPT. The adapter uses the CLI's own model and account settings and does not read or copy the stored credentials.

After building the Web assets from the repository root, launch Web with the [Assistant overlay](../assistant/cordis.patch.yml) and the [Local Codex overlay](cordis.patch.yml):

```sh
pnpm run build:artifacts
pnpm dsh web \
  --patch ./packages/experimental/assistant/cordis.patch.yml \
  --patch ./packages/experimental/llm-codex/cordis.patch.yml \
  --host 127.0.0.1 --port 0 --no-open
```

Open the printed URL and choose **Assistant** from **More** in the sidebar. The overlay sets the default model to **Codex default** under **Local Codex** and skips the DeepSeek API key prompt. A Session with a recorded selection keeps it until you change the model in the composer. The overlay uses the first prompt for the Session title.

### Minimal configuration

In a custom composition that provides `llm` and `subprocess`, mount the adapter with this entry and route model requests to `codex-local/default`. The `default` model follows Codex configuration; a custom composition can also route to an explicit Codex model ID.

```yaml
- name: '@deepseek-ai/dsh-llm-codex'
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `codex` | Executable on the Host's `PATH` or an absolute executable path. |
| `timeoutMs` | `120000` | Time limit in milliseconds to obtain one model response. |
| `disposeGraceMs` | `3000` | Milliseconds between managed process termination stages. |

See the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-codex) for the accepted fields and required services.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [adapter](src/index.ts) registers a provider with Harness. Each request starts a [managed Codex subprocess](src/app-server.ts) and creates a temporary thread in an empty working directory. For an explicit model ID, the adapter checks that the thread reports that ID before starting the turn. Harness projects the Session history and registered tools into the thread. The adapter publishes the response after the subprocess exits. Harness executes any returned tools under its own policies, then includes their results in the next request.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Assistant](../assistant/README.md) — delegate work and inspect saved reports.
- [Experimental packages](../README.md) — support and composition policy.
- [LLM streaming](../../../docs/subsystems/llm-streaming.md) — routing, model messages, and response chunks.

-----

<a id="model-experience"></a>
## Model Experience

### Instructions and history

#### What the model sees

Codex receives the Harness instructions and projected text history, including the `user`, `developer`, and `assistant` roles. It receives earlier tool calls and their results under the original call IDs. The adapter carries Codex's replayable reasoning only when the response came from the same concrete model.

#### Token effect

Every request sends the current projected history, so retained messages and tool results continue to count as input. Codex supplies token counts when available.

#### KV Cache effect

Each request uses a new Codex thread. The adapter sends the history again and cannot guarantee reuse of its earlier prefix by the provider.

### Tool definitions

#### What the model sees

Codex exposes the available Harness tool names, descriptions, and parameter schemas in the `dsh_harness` namespace. The namespace instructs the model to call its tools directly and choose them when names overlap. Harness executes the admitted calls.

#### Token effect

Tool definitions count as input when present.

#### KV Cache effect

A change in the available tool definitions changes the next request's tool prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Use this experimental route for text Sessions that fit the selected Codex model's context window.

- **Request options** — Native image and file inputs and the `maxTokens`, `temperature`, and `stop` request options are unsupported. Harness can still supply attachment text.
- **Session compaction** — Harness does not summarize history automatically on this route. The `/compact` command reports that compaction is unavailable.
- **Response timing** — Answers arrive after each model call completes. Harness does not automatically retry an interrupted or failed Codex request.
- **Codex native tools** — Some Codex models advertise native Code Mode tools alongside Harness tools. If the model selects a native tool, Harness rejects the response and reports the rejected operation.
- **CLI compatibility** — The adapter uses Codex's experimental `thread/inject_items` and raw response events, checked with Codex CLI `0.153.4` and `0.167.0`. If requests fail after a CLI update, check `codex --version` and `codex login status`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

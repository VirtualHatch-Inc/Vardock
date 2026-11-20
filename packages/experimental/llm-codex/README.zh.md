---
description: "通过现有的本地 Codex CLI 登录发起 DeepSeek Harness 模型请求，无需在 Harness 中设置 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex

[English](README.md) | 中文

## 概述

使用本地 Codex CLI 的登录状态回答 Harness 中的文本请求。Web 助手可以委派工作并接收报告，主会话和工作会话可使用同一模型路由。Codex 负责身份验证，无需在 Harness 中输入 API 密钥。请求受 Codex 账号的使用限额约束。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在运行 Harness 宿主的环境中，确认可以运行 `codex`，且 `codex login status` 显示已通过 ChatGPT 登录。如果尚未登录，请运行 `codex login` 并选择 ChatGPT。适配器使用 CLI 自身的模型和账号设置，不读取或复制保存的凭据。

在仓库根目录构建 Web 产物后，使用 [Assistant 补丁](../assistant/cordis.patch.yml)和[本地 Codex 补丁](cordis.patch.yml)启动 Web：

```sh
pnpm run build:artifacts
pnpm dsh web \
  --patch ./packages/experimental/assistant/cordis.patch.yml \
  --patch ./packages/experimental/llm-codex/cordis.patch.yml \
  --host 127.0.0.1 --port 0 --no-open
```

打开打印出的 URL，在侧栏的**更多**菜单中选择**助手**。补丁将默认模型设为 **Local Codex** 下的 **Codex default**，并跳过 DeepSeek API 密钥提示。已记录模型选择的会话会保留该选择，直到你在输入区更换模型。补丁使用首条提示生成会话标题。

### 最小配置

如果自定义组合提供 `llm` 和 `subprocess`，可使用下面的条目挂载适配器，并将模型请求路由到 `codex-local/default`。`default` 模型遵循 Codex 配置；自定义组合也可以指定 Codex 模型 ID。

```yaml
- name: '@deepseek-ai/dsh-llm-codex'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `codex` | 宿主 `PATH` 上的可执行文件名，或可执行文件的绝对路径。 |
| `timeoutMs` | `120000` | 等待一次模型响应的时限，单位为毫秒。 |
| `disposeGraceMs` | `3000` | 受管理进程各终止阶段之间的毫秒数。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-codex)列出接受的字段与所需服务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节，点击展开</summary>

[适配器](src/index.ts)向 Harness 注册一个提供方。每次请求启动一个[受管理的 Codex 子进程](src/app-server.ts)，在空工作目录中创建临时线程。指定模型 ID 时，适配器会在开始回合前确认线程报告的是该 ID。Harness 将会话历史和已注册工具投射到线程中。子进程退出后，适配器发布响应。Harness 按自身策略执行响应中的工具调用，再将结果加入下一次请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Assistant](../assistant/README.zh.md)——委派工作和查看已保存的报告。
- [实验包](../README.zh.md)——支持范围和组合策略。
- [LLM 流式输出](../../../docs/subsystems/llm-streaming.zh.md)——路由、模型消息与响应片段。

-----

<a id="model-experience"></a>
## 模型体验

### 指令与历史

#### 模型看到的内容

Codex 接收 Harness 指令和投射后的文本历史，其中保留 `user`、`developer` 和 `assistant` 角色。先前的工具调用与结果保留原有调用 ID。只有响应来自同一具体模型时，适配器才携带 Codex 可重放的推理内容。

#### Token 影响

每次请求都发送当前投射后的历史，因此保留的消息和工具结果继续计入输入。Codex 在可用时提供 Token 计数。

#### KV Cache 影响

每次请求都使用新的 Codex 线程。适配器重新发送历史，无法保证提供方复用先前的前缀。

### 工具定义

#### 模型看到的内容

Codex 在 `dsh_harness` 命名空间中提供可用 Harness 工具的名称、描述和参数 schema。该命名空间要求模型直接调用其中的工具，并在工具重名时优先选择它们。Harness 执行获准的调用。

#### Token 影响

存在工具定义时，工具定义计入输入。

#### KV Cache 影响

可用工具定义变化时，下一次请求的工具前缀也随之变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

此实验路由适用于不超过所选 Codex 模型上下文窗口的文本会话。

- **请求选项**——不支持原生图片和文件输入，也不支持 `maxTokens`、`temperature` 或 `stop` 请求选项。Harness 仍可提供附件文本。
- **会话压缩**——Harness 不会在此路由上自动总结历史。`/compact` 命令会报告压缩不可用。
- **响应时机**——每次模型调用完成后才显示回答。Harness 不会自动重试中断或失败的 Codex 请求。
- **Codex 原生工具**——部分 Codex 模型在提供 Harness 工具的同时也会提供原生 Code Mode 工具。如果模型选择原生工具，Harness 会拒绝响应并报告被拒绝的操作。
- **CLI 兼容性**——适配器使用 Codex 的实验性 `thread/inject_items` 和原始响应事件，并已用 Codex CLI `0.153.4` 和 `0.167.0` 检查。如果更新 CLI 后请求失败，请检查 `codex --version` 和 `codex login status`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

无。

</details>

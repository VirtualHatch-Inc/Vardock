---
description: "与通道无关的一次性审批 seam；供组合应答者、设置策略或排查以拒绝方式关闭的权限决定的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-approval

[English](README.md) | 中文

## 概述

使用本包可要求敏感工具操作在继续前取得一次性决定。`ask` 策略将每个请求发送给部署中的人类或机器应答者；`never` 则直接拒绝，不发出提示。应答者缺失或失败时返回 `unavailable`，使操作以拒绝方式关闭；每项批准也只适用于对应请求。每个请求与结果都会记录在发起请求的会话审计日志中。模型会看到最终工具结果与当前策略，但不会看到人类权限 UI 或审计事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当敏感工具操作需要人或机器作出决定时，组合此服务。它需要 `sessionProjections`；`requestBackground` 还会读取可选的 `sessions` 服务，缺少时拒绝请求。发布的配置档同时提供两者。工具流水线与沙箱 bash 工具会通过此 seam 路由 `ask` 决定，并在该 seam 缺失时以拒绝方式关闭，因此交互式部署至少应组合一个应答者。

### 组合应答者

应答者是 `approval/request` waterfall（瀑布式事件）监听器：返回一个结果即为所负责的 agent（智能体）作答，否则调用 `next()` 委托。限定到 agent 的监听器只接收该 agent 的请求，且每项部署应组合一个最终应答者——同级监听器的顺序不是策略优先级机制。没有最终应答者时，请求解析为 `unavailable` 并以拒绝方式关闭；服务自身绝不会提示人类。

### 设置策略

有效策略取会话中已设置的策略，并回退到配置的默认值。`ask`（默认）委托给已组合的应答者；`never` 在交互式分发之前确定性地拒绝每个请求——这是 CI 与无人值守运行采用的严格无头模式。

```yaml
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `policy` | `ask` | 没有 `approval/policy` 覆盖的会话的默认策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-user-approval)是每个受支持字段及其 JSDoc 的穷尽式真源。`setPolicy(agent, policy)` 切换运行中的 agent 的策略，并为它的下一个模型步骤排队一条模型体验一节所述的切换通知；`setApprovalPolicy(session, policy)` 是会话初始化使用的直接持久写入路径。

### 请求决定

`request(req)` 在发起请求的 agent 的开放轮次内发起审批。后台操作可使用 `requestBackground(req)` 通过应答 agent 的会话发起审批，包括会话空闲时。调用方须提供具有活动持久化写入句柄的会话。服务在分发前持久化请求，在返回前持久化决定。审计或检查点失败、或没有检查点监听器时，请求会被拒绝。

通过 `reason` 提供审计日志要记录的操作。`displayReason` 提供本地化标题，`detail` 为没有关联工具调用的独立操作提供纯文本。中止待回答的问题会记录 `cancelled` 并丢弃迟到的回答。审计事件追加失败会拒绝请求。

### 模型与用户看到什么

模型只会看到发起请求的消费方最终给出的工具结果——允许、拒绝、取消或不可用——以及运行时上下文快照中的当前策略；审计事件与面向人类的权限 UI 不属于模型上下文。每次策略切换都会以一条带来源的用户消息告知模型，两种策略都会把各自的完整当前含义贡献给快照。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释分发、策略执行与审计路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ApprovalService`：请求分发、私有审批状态、策略写入路径、运行时上下文贡献 |
| [`src/types.ts`](src/types.ts) | `ApprovalRequestId` brand 与结果类型 |

### 分发

两种请求方法均在应答者 waterfall 期间监听中止信号，并将应答者异常或无效结果转换为 `unavailable`。服务在分发 waterfall 之前执行 `never` 策略，使用 `prepend` 注册的应答者也适用。

### 策略与运行时上下文快照

私有的 Host 端 `approvalState` Projection 保存策略覆盖值，以及当前轮次是否仍未结束。其大小不随事件数增长。注册表会将它保存到持久化检查点；事件日志仍是真源。其纯状态更新不会发起问题或授予权限。

服务激活会等待 Projection 注册完成；注册失败会使激活失败。服务私有持有返回的读取句柄。宿主和注册表负责会话恢复；审批方法不会在同步读取时加载历史或调用 hydration。参见[注册与恢复 API](../../session/session-projection/README.zh.md)。待处理问题、应答者和授权仍由运行时负责。

系统提示词贡献 `approval:policy` 在保留历史之后陈述有效策略的完整当前含义——`ask` 及其以拒绝方式关闭的后果，或 `never` 及其非升权后果——因此切换策略会追加一份新的完整快照，而不会改写稳定的请求头。`setPolicy()` 还会注入一条带来源的用户消息，为下一步宣布变更。

### 审计

两种方法都会将 `approval/asked` 和对应的 `approval/decided` 追加到应答会话。审计事件独立于模型历史。单独的操作授权记录由调用方负责。[审计实现](src/index.ts)

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从审批词汇逐步进入消费方与设计依据。

- [审批子系统参考](../../../docs/subsystems/approval.zh.md)——共享的请求／结果词汇与 `ctx.approval` 的 Cordis 接口面。
- [审批 seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md)——该 seam 的设计依据。
- [沙箱 参考](../../shell/tool-bash/README.zh.md)——沙箱 bash 工具如何为升权重试消费审批。
- [交互组映射](../README.zh.md)——相邻的权限预设与问答包。

-----

<a id="model-experience"></a>
## 模型体验

### 当前审批策略上下文

#### 模型看到的内容

首次请求与有效策略每次变化时，都会在保留的历史后追加一份完整运行时上下文快照。在 `ask` 下，审批上下文内容会说明系统可以咨询已配置的应答者，缺少可用应答者时则以拒绝方式关闭。在 `never` 下，它会说明确定性的拒绝与非升权后果。未变化的请求会保留先前快照，不增加另一条消息。用户切换运行中 Session 的策略时，下一次模型调用还会收到一条切换通知。

##### Ask 策略贡献

```markdown
Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never 策略贡献

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

##### 切换通知

```markdown
The user changed the approval policy from "ask the user for approval" to "never ask the user for approval".
```

#### Token 影响

首次请求和策略实际变化时增加一条简洁的上下文消息；未变化的请求不增加重复的策略 token。

#### KV Cache 影响

在保留的历史之后仅追加。`ask`／`never` 切换会保留稳定的系统与对话前缀，而不会改写第一条 wire 消息。

### 工具结果

#### 模型看到的内容

`approval/asked` 和 `approval/decided` 只写入日志。模型只会看到发起请求的消费方最终给出的允许、拒绝、取消或不可用工具结果；面向人类的权限 UI 不属于上下文。

#### Token 影响

不会产生重复的审计 token。拒绝可能以一条简短且会保留的错误信息替换正常工具结果，而允许会保留消费方的普通结果。

#### KV Cache 影响

仅追加；新出现的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 不适用的场景，以及组合时需要特别注意的场景。它们是当前包约束，不是通用权限对比。

- **仅存在一次性授权**：结果词汇包含 `allowed-once`，但不含 `allow-always`、已记住的规则、撤销或授权存储；会话策略只有 `ask`／`never`。
- **ACP 需要工具调用 ID。** 它会委托不含调用 ID 的独立请求。
- **没有内置应答者**：无头或组合不完整的部署会返回 `unavailable` 并以拒绝方式关闭；服务自身绝不会提示人类。
- **待处理审批仅在进程内有效**：检查点恢复策略和轮次状态，不恢复待处理应答的 Promise 或一次性授权。恢复不会重新提交问题或重复运行时副作用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

---
kind: upgrade-guide
description: "新的 Assistant 工作必须声明权限，授权服务的 `assistant.permissions.data` 必须包含 `returnResponses`，由它决定业务响应文本能否到达工作脚本。"
---

# Assistant 工作声明权限与响应访问

[English](guide.md) | 中文

## 变更

此前，省略 `permissions` 的委派会获得[操作授权服务](../../../../packages/experimental/operation-control/README.zh.md)的整个 `assistant.permissions` 上限。现在授权服务以 `work-permission-required` 拒绝未声明权限的新工作；未声明权限的继续工作保留前序工作的授权。`delegate_work` 工具将 `permissions` 描述为新工作必填。

带附件的所有者请求触发入口轮次时，新的 `delegate_work` 调用还必须声明 `inputs`：附件坐标，或在工作不需要文件时传入 `[]`。省略时会在创建授权或工作会话前以 `work-file-denied` 拒绝；错误会列出每个附件及其选择值。不带附件的请求与继续工作仍保留原有的省略行为。选中的输入仍需要导入权限和两项披露权限。

此前，配置了 `returnResponse: true` 的操作会把响应文本返回给每个请求它的工作脚本。现在仅当上限和工作授权都允许新的数据权限 `returnResponses` 时才返回文本；否则请求仍会发送并记录，回复携带 `bodyOmitted: "not-permitted"`。只要提供 `assistant.permissions.data`，授权服务的 `Config` 就要求 `returnResponses`，缺少它的 Profile 无法加载。此变更之前记录的工作授权没有 `returnResponses`，不返回响应文本；其请求在其他方面不变。

受影响的是由 `vardock setup` 或手工编写的授权服务 Profile，以及为新委派调用 `HandoffControl.release` 却不传 `delegation.permissions` 的宿主代码。

## 迁移

1. 停止 Vardock。
2. 在授权服务 Profile 的 `operation-control` 条目中，为 `assistant.permissions.data` 添加 `returnResponses`：`true` 允许获授此权限的工作接收响应文本，`false` 对所有工作隐藏响应文本。`vardock setup` 现在写入 `true`。
3. 在宿主代码中，为每个新委派传入 `delegation.permissions`。在附件触发的入口轮次中调用 `delegate_work` 或 `AssistantRuntime.delegate` 时，还须传入选中的 `inputs` 或显式空列表。
4. 若要让现有工作获得响应文本，请以 `data.returnResponses: true` 委派新工作；继续工作不能获得该权限。
5. 启动 Vardock 并确认授权服务已加载，然后委派调用 `returnResponse: true` 操作的工作，检查其脚本仅在工作授权允许 `returnResponses` 时收到 `body`。

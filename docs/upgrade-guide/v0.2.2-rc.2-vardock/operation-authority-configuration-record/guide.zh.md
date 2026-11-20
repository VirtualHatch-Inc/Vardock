---
kind: upgrade-guide
description: "操作控制服务在见证服务确认其变化后配置的记录之前拒绝请求，其授权设置携带该记录的回执，其数据库升级到架构版本 13。"
---

# 操作控制服务向见证服务记录其配置

[English](guide.md) | 中文

## 变更

当启动时的配置与数据库上次记录的配置不同时，`@deepseek-ai/dsh-operation-control` 向见证服务发送一个 `configuration` 事件，并在见证服务确认之前以 `configuration-evidence-unavailable` 拒绝所有请求。此前，启动会在没有任何见证事件的情况下替换授权修订号。见证服务拒绝的配置记录（例如超过 64 KiB 的记录）会使启动以 `configuration-evidence-refused` 失败。

配置指纹现在涵盖所记录的配置，因此升级后的首次启动会替换一次授权修订号：与任何配置变化之后一样，尚未消费的批准和许可不再有效。数据库以架构版本 13 打开；此后该包的早期版本无法打开它。

`OperationControlClient.grant()` 和 `updateGrant()` 的响应以及 `HandoffControl.grantSettings()` 包含必需的 `configuration` 回执（`id`、`digest`）。`verifyRecords(approver, evidence)` 还会调用 `approver.grant()`，因此 `approver` 除 `receipts` 外还需要 `grant`，结果也可能报告 `event-missing` 问题。

## 迁移

1. 在控制服务之前启动见证服务，或在其后尽快启动：见证服务确认记录之前，控制服务不处理任何请求。
2. 升级前处理待审批项，或在升级后重新批准。
3. 在构造 `OperationGrantBudget` 值或向 `verifyRecords` 传入自定义 `approver` 的代码中，添加 `configuration` 回执和 `grant` 方法。
4. 用 `pnpm vardock verify` 确认：它比对当前配置记录，且不报告 `event-missing` 问题。

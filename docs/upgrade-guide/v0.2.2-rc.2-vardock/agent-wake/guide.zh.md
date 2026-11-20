---
kind: upgrade-guide
description: "自定义 Agent 驱动器必须实现 wake()，以启动对 inbox 中已有输入的处理。"
---

# 自定义 Agent 驱动器实现 `wake()`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent` 的公开 `Agent` 接口要求提供 `wake(): void` 方法。实现 `Agent` 的自定义驱动器和测试替身都受此影响。

## 迁移

1. 通过驱动器现有的启动流程实现 [`Agent.wake()`](../../../subsystems/core.zh.md#the-agent-handle)。保留待处理输入在 inbox 中的位置，活动进行期间延后唤醒；inbox 为空或正在释放时跳过唤醒。
2. 按 `Agent` 接口检查实现的类型。用 `send(message, target, false)` 将一条输入加入队列，再调用 `wake()`，确认驱动器只处理一次该消息。

---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-assistant-work

[English](2026-11-09-assistant-work.md) | 中文

## 概述

新增 assistant-work 消息来源，用于持久化的委派请求和结果通知。在现有收件箱与消息事件中记录工作标识、请求或结果方向、notice 形式和摘要。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-assistant-work
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "0ee879606d0d2d349db16c2084aff076561e9df87b492bc140e5724817fcfe46"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "09ea8e01021d15f6def5b010f07b65b84907519ed46a6c06cfc48e229fe2171c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "dba7890955f7da01ea6c22aced7c49332dd7be1c30d1d224410ca5b5f8d009c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "42c291d9b472a37338b74ef529e780ff036476ec273d607079a754cabb0a79fa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有消息仍然有效。新来源使用独立的 assistant-work kind 和已有的 notice 形式。Session 读取器已允许用户和开发者消息使用非空来源 kind，并保留内容和来源字段；未加载此插件的消费者将其视为普通通知。当前读取器也继续接受原有来源。事件判别字段与 Session 头部解释均未改变，因此不增加写入版本。助手投影重建结果接收回执；移除插件不会重放命令。独立的 assistant 存储域从版本 1 开始，不修改已发布的 Session 代际。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/assistant/tests/assistant.spec.ts：10 个测试通过，使用真实 JSONL 持久化、storage-domain、SessionController、检查点策略和 Loader。覆盖独立工作者、重复键、重启恢复、已保存结果接收、取消、调度失败和并发暂存。现有 Agent 测试覆盖未知来源。

<a id="dev-note"></a>
## 开发备注

无。

---
kind: upgrade-guide
description: "带有 match 的无人值守规则现在必须用 allow 列出其他允许的请求字段。"
---

# 带有匹配条件的无人值守规则必须提供 allow 列表

[English](guide.md) | 中文

## 变更

`operation-control` 配置档的 `unattendedBrokerActions` 规则只要提供 `match`，就必须提供 `allow`。以前，省略 `allow` 会使其他所有字段不经检查。现在，授权服务会拒绝加载这种配置档。对于操作 `capture`，加载错误包含以下确切诊断：

```text
Unattended rule for action "capture" must add allow (use allow: [] to permit no other fields).
```

没有 `match` 的规则仍接受相同字段。在连接编辑器中，填写条件但将其他字段输入框留空会保存 `allow: []`。授权服务检查 `allow` 中字段的名称，但不检查它们的值。

如果开发数据库中已保存的所有者规则带有 `match` 却没有 `allow`，加载会失败并报告 `storage-unavailable`，原因为 `The saved unattended rules are corrupt`。没有迁移会改写这些经见证的记录。

只要发往同一操作的较早请求结果尚未确认，后续请求即使正文不同也会等待所有者批准。以前只有正文完全相同的重复请求才会等待。审批卡片会列出较早的操作。

## 迁移

1. 停止 Vardock。在授权服务配置档的 `cordis.patch.yml` 中，找到 `operation-control` 条目及每条带有 `match` 的 `unattendedBrokerActions` 规则。
2. 添加 `allow: []`，只允许 `match` 中的字段，或逐一列出其他允许的顶层字段。例如，`{ action: capture, match: { account: A1 }, allow: [amount] }` 允许 `account: A1` 和可选的 `amount` 字段，不允许其他字段。
3. 对于出现已保存规则错误的可丢弃开发数据库，停止两个服务并保留授权服务和见证服务数据库，然后为两个服务配置新的 `databasePath` 并重新创建规则。不要丢弃结果未确认的操作记录，也不要编辑经见证的记录来绕过错误。
4. 启动 Vardock 并确认授权服务成功加载。在连接页面中，确认空列表显示不允许其他字段，非空列表则列出允许的字段。
5. 向同一操作发送更多请求前，检查结果尚未确认的操作。使用已配置的结果查询确认较早的结果；改变 JSON 字段顺序或允许字段的值不再能绕过所有者批准。

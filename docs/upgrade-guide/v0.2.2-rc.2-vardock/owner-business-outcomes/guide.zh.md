---
kind: upgrade-guide
description: "业务完成状态可携带没有外部回执 ID 的所有者判定，授权数据库升至模式版本 13。"
---

# 所有者判定业务结果

[English](guide.md) | 中文

## 变更

业务状态和业务记录中的 `businessCompletion` 现在可包含 `{ kind: "succeeded" | "failed", source: "owner", receipt }`。这是所有者核查后通过既有对账记录见证的结果，没有外部 `receiptId`。查询结果保留原有字段。对于每个终态完成都要求 `receiptId` 的客户端，必须处理所有者形式。

业务记录页面新增**我已核实：已发生**和**我已核实：未发生**。特权 `POST /resolve-business` 请求接受 `{ id, kind }`，其中 `kind` 为 `succeeded` 或 `failed`。没有模型或工作方工具提供此功能。判定只有经见证确认后才生效。

授权数据库升至模式版本 13，不改写较早的记录。旧版授权服务无法重新打开它。

## 迁移

1. 同时升级授权服务和 Assistant Host。升级前保留授权服务及见证服务数据库；不要通过替换数据库清除结果未确认的操作。
2. 自定义客户端在读取 `receiptId` 前，须区分 `source: "owner"` 和查询结果；两种情况下都用 `receipt` 获取见证确认。
3. 核查结果尚未确认的外部操作后，在**业务记录**中选择对应操作。确认该行标明所有者，且 `pnpm vardock verify` 没有报告不匹配。如果判定尚未确认，请读取当前记录并检查授权服务和见证服务后再重试。

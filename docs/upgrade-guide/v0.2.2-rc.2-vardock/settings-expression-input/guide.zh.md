---
kind: upgrade-guide
description: "设置表单写入拒绝配置表达式。"
---

# 仅在 profile patch 中编写配置表达式

[English](guide.md) | 中文

## 变更

`settings.update`、`settings.replace` 和 `settings.mutate` 曾接受带 `__jsExpr` 键的对象作为表单值，将其作为 `!!js` 表达式存入 profile patch，并由 Loader 在 Host 进程中求值。现在，若值包含 `__jsExpr` 键或 `mutate` 路径指向该键，这些写入返回 `settings/rejected`。这影响通过设置写入表达式的 Remote 和 SDK 调用方；已发布的客户端不会发送表达式。

## 迁移

1. 直接在当前 profile 的 `cordis.patch.yml` 中编写 `!!js` 表达式，然后重启或由热重载应用。
2. 确认插件的设置表单显示求值后的值。

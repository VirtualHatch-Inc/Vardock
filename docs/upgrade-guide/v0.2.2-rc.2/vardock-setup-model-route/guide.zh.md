---
kind: upgrade-guide
description: "`pnpm vardock setup` 必须传入 `--model-provider` 和 `--model`，省略两者时不再选择 Local Codex。"
---

# Vardock 设置需要指定模型路由

[English](guide.md) | 中文

## 变更

此前，不带 `--model-provider <route> --model <id>` 的 `pnpm vardock setup` 会使用 Local Codex。现在它会在做出任何更改之前停止，并列出可用路由：pi-ai 适配器的 LLM API Provider 路由及其模型 ID，或用于 Local Codex 的 `codex-local` 及模型 `default`。受影响的是不带这两个选项运行设置的脚本和说明。已有部署不受影响。

## 迁移

1. 使用 Local Codex 时，将 `pnpm vardock setup` 替换为 `pnpm vardock setup --model-provider codex-local --model default`，并保留原有的 `--home` 和 `--port`。此路由仍会检查 Codex 登录。
2. 使用 LLM API Provider 时，改为传入其路由和模型 ID，例如 `--model-provider openai --model "<model-id>"`，并在首次启动后于插件页的**连接**中保存密钥。
3. 确认设置命令打印 `Prepared Vardock in <home>.`

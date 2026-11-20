---
kind: upgrade-guide
description: "继承的 GitHub Actions 工作流、GitLab 流水线、仓库自动化，以及仅供 CI 使用的 `pnpm run` 脚本已移除。"
---

# CI 自动化已移除

[English](guide.md) | 中文

## 变更

仓库不再包含 `.github/workflows`、`.github/issue-management`、`.github/review-ownership`、`.github/preview-sizing`、`.github/dependabot.yml` 或 `.gitlab-ci.yml`。本仓库不再触发任何托管 CI、发布、公开、签名、Issue 分拣、评审路由或 Dependabot 运行。以下脚本已不存在，调用时报告脚本缺失：`test:approval-policy`、`test:issue-management`、`check:ci` 及所有 `check:ci:*` 通道、`test:web:ci` 和 `typecheck:contracts-ready`。`apps/desktop/scripts/` 下的 Desktop CI 发布脚本和自托管 runner 脚本已移除；本地打包和上传命令不变。被移除通道运行的每个门禁仍以其本地命令保留，设置 `CI` 或 `GITHUB_ACTIONS` 时门禁命令的行为不再改变。原先只由 CI 运行的受跟踪文件名检查和包元数据检查，现在作为 `verify-expected-filenames` 和 `verify-package-meta` 在 `pnpm run hygiene` 中运行。

## 迁移

1. 从调用上述脚本的本地脚本或自动化中移除它们。
2. 使用[开发指南](../../../development.zh.md)中的命令在本地运行检查；`pnpm run check:all` 运行全面的门禁集，`pnpm run test:bench` 取代 `check:ci:bench`。
3. 运行 `pnpm run hygiene`，确认 `expected filenames` 和 `package metadata` 门禁通过。

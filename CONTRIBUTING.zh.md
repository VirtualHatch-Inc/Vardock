# 为 Vardock 做贡献

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md) | 中文

Vardock 是 DeepSeek Harness 的独立定制项目。请在本仓库讨论 Vardock 的行为和变更提案；不要向上游 DSH 维护者发送 Vardock 专属的支持请求。参与本项目须遵守[行为准则](CODE_OF_CONDUCT.zh.md)。

## 报告问题

请提供受影响的组件、操作系统、版本、最小复现、预期行为和实际结果。请从日志中移除访问令牌、凭据、私人输入和 Session 内容。敏感报告请遵循[安全说明](SAFETY.zh.md#local-operation-and-reports)。

## 提交变更

保持变更小而明确，复用 DSH 服务和 Cordis 扩展点。阅读 [AGENTS.md](AGENTS.md)、[架构](docs/architecture.zh.md)和[开发指南](docs/development.zh.md)。行为发生变化时，请更新负责说明该行为的文档及其语言对应文件。

运行适用于受影响组件的检查，并报告命令和结果。[测试指南](docs/testing.zh.md)说明单元、快照、Provider 和构建检查。贡献中不得包含运行时目录、本地凭据、数据库内容或生成的构建产物。

请保留上游版权、许可证声明和归属。源码贡献采用本仓库的 [MIT 许可证](LICENSE)；请披露新增依赖，以及提供的图案或其他材料的再分发条款。

## 分发

受支持的评估路径是[基于源码的 macOS 设置](packages/experimental/assistant/vardock/README.zh.md)。继承的 npm、桌面、Python 和网站发布脚本面向 DSH 基础设施，需要单独配置 Vardock 发布流程并审查再分发要求。发布仓库源码本身并不意味着获准再分发所有打包依赖。

## 版本

Vardock 版本是公开仓库上名为 `vardock-vMAJOR.MINOR.PATCH` 的附注 Git 标签，候选版本为 `vardock-vMAJOR.MINOR.PATCH-rc.N`；其他仓库通过该标签固定 Vardock 版本。`dsh-v*` 标签标记上游 DSH 发布，而不是 Vardock 版本。根 `package.json` 保留上游 DSH 版本，因为[工作区约束](scripts/check-workspace-constraints.ts)要求每个 `@deepseek-ai/dsh*` 包都使用根版本。每个标签消息都会写明该版本所基于的上游发布，例如 `Based on dsh-v0.2.2-rc.2`。

要安装某个标签的 Vardock，请在该标签处克隆仓库，运行 `pnpm install --frozen-lockfile`，然后按 [macOS 设置指南](packages/experimental/assistant/vardock/README.zh.md)带模型路由运行 `pnpm vardock setup`。请保留该检出：生成的 Profile 引用其中构建的包。

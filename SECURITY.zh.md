# 安全策略

[English](SECURITY.md) | [日本語](SECURITY.ja.md) | 中文

## 受支持的版本

Vardock 是开发者预览版软件，尚无任何发布版本。仅支持当前默认分支；针对旧提交的报告将以默认分支为准进行评估。

## 报告漏洞

请通过 GitHub 私密漏洞报告提交疑似漏洞：打开仓库的 **Security** 标签页并选择 **Report a vulnerability**，即打开 <https://github.com/VirtualHatch-Inc/Vardock/security/advisories/new>。只有在仓库公开且维护者启用私密漏洞报告后，该表单才可用。如果表单不可用，请创建一个不含任何漏洞细节的 Issue，请求维护者提供私密渠道。

不要创建包含凭据、私人会话或可直接利用的攻击步骤的公开 Issue。

## 报告应包含的内容

- 受影响的包或命令，以及你测试的提交。
- macOS、Apple Container 和 Node.js 的版本，以及模型提供方路由（不含其密钥）。
- 复现步骤、预期结果与实际结果，以及影响。
- 攻击者所需的访问权限，例如本地 OS 用户、模型响应、Broker 目标或工作 VM。

请从日志和附件中移除访问令牌、API 密钥、Session 内容和私人输入。

## 响应

本项目不承诺响应时限、修复日期或专门的安全响应服务。

## 威胁模型与限制

[安全说明](SAFETY.zh.md)描述了威胁模型、操作控制服务不涵盖的内容以及记录核验的限制。依赖于控制运行 Vardock 的 OS 用户的报告，描述的是 macOS 开发设置中已记录的限制。

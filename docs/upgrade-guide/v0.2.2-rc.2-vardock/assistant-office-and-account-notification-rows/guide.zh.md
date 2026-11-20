---
kind: upgrade-guide
description: "Assistant 补丁移除不配置 Vardock 工作的继承宿主控件和设置。"
---

# Assistant 补丁移除无关的宿主控件

[English](guide.md) | 中文

## 变更

[Assistant 补丁](../../../../packages/experimental/assistant/cordis.patch.yml)禁用继承的设置、命令来源、编码工作流卡片，以及宿主终端、浏览器、文件和本机应用控件。模型和账号设置不再显示；请使用“连接”管理 Vardock 凭据。Office 转换、Office 技能、账号通知轮询和继承的会话日志上传均被禁用。PTC、精简和 Cordis 预设、MCP 服务器管理器、DeepSeek 账号服务、Session 遥测导出、Cordis 提供方检查和宿主目录选择器均被卸载，因此侧边栏不再提供添加工作区。这些变更影响加载 Assistant 补丁的 Web 配置档，包括由 `vardock setup` 创建的部署；普通 DSH 配置档不变。

[Assistant README](../../../../packages/experimental/assistant/README.zh.md#use-this-package)按组说明禁用的控件以及保留的功能。Assistant 结果文件卡片、内嵌预览和下载仍可使用。预设控件保留，因为只读清单使用其词典。该补丁将 `plugin-manager` 设为 `management: fixed`：不提供组合包目录或变更控件，并拒绝管理器的变更请求。其他配置档保留默认的 `full` 模式。

现有部署中已启用的可选组合包会继续运行，直到编辑其配置档；限制管理器不会将其停用。重启前，请从 `<home>/web/profiles/web/package.json` 的 `dsh.profile.bundles` 中移除自动授权审核组合包 `@deepseek-ai/dsh-experimental-auto-review`。

## 迁移

1. 更新 Web 启动器的 `--patch` 所指向的仓库或已安装 Assistant 包，然后在适当的时候重启 Vardock 部署。现有配置档无需重写。
2. 使用“插件”中的“连接”和“业务记录”，通过“自动化任务”管理计划，并在 Assistant 工作行查看执行者结果和成果文件。
3. 确认继承的宿主控件、插件目录和变更控件已消失，然后在 Assistant 工作中预览并下载一个结果文件。
4. 如果自定义 DSH 配置档确实需要某个被禁用的行，可通过靠后的 `--patch` 指定其准确 id 和 `disabled: false`。Office 预览还需要 `office-kit`、`ui-sidebar-documentpreview` 和 `ui-sidebar-files` 等文件打开入口。这类宿主功能不属于 Vardock 已验证的工作路径。

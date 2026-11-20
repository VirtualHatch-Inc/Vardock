---
kind: upgrade-guide
description: "Vardock设置支持控制服务补丁，Broker目标支持限定范围的CA文件，其变更会使已保存的路由规则失效。"
---

# 在设置时配置控制服务连接

[English](guide.md) | 中文

## 变更

`pnpm vardock setup`接受可重复的`--authority-patch <file>`选项。配置档加载器按顺序在生成的控制服务补丁之后应用这些文件。此前操作员通过编辑生成的配置档添加连接和权限。设置保留其他角色，并拒绝使用已有部署目录。

HTTPS JSON Broker路由和MCP服务器条目接受可选的`ca` PEM文件路径。此前信任私有CA需要`NODE_EXTRA_CA_CERTS`等进程级配置。配置的CA仅替换该路由或端点的默认信任根；HTTPS状态查询使用同一信任。证书及主机名验证保持启用。

CA路径和内容摘要纳入路由摘要及提供方指纹，并记录在控制服务的见证配置中。未设置`ca`的配置保留原有标识。更改已配置的CA会使未使用的许可失效，并使所有者为该路由保存的规则停用。

## 迁移

1. 现有部署无需更改。新部署可在包含模型选项的设置命令后添加`--authority-patch /absolute/path/service.yml`；多个补丁可重复指定。请提供完整的行配置：Cordis补丁替换一行的整个`config`，不会合并单独字段。参见[设置指南](../../../../packages/experimental/assistant/vardock/README.zh.md#connect-a-service)。
2. 要信任私有CA，请停止Vardock，在`<home>/authority/profiles/operation-authority/cordis.patch.yml`中的目标Broker路由或MCP服务器上设置`ca: /absolute/path/company-ca.pem`，或在新部署的补丁中设置。文件必须包含有效的PEM证书，并始终可由控制服务读取。
3. 启动Vardock。提供方加载时读取CA，并在准入前见证变更后的配置。CA变更后，请在连接页审查并保存该操作的规则，以恢复无人值守请求。运行`pnpm vardock verify`以比对当前配置及操作回执。只有其他连接仍需使用时才保留进程级额外CA。

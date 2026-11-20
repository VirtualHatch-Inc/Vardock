---
kind: upgrade-guide
description: "新建Vardock部署默认自动运行脚本，除非选择review-scripts。"
---

# Vardock设置中的自动脚本

[English](guide.md) | 中文

## 变更

`pnpm vardock setup`在制御部配置中写入`unattendedShell: true`。此前每个脚本都等待批准。脚本在无网络的工作环境中运行；准入和结果证据仍会记录并由见证服务确认。业务请求等待批准，除非所有者规则允许自动执行。笔记和计划仍需批准。现有部署不会被重写。

## 迁移

1. 要新建逐一审查脚本的部署，请在原有设置命令中添加`--review-scripts`，同时保留`--model-provider`和`--model`。
2. 要将现有部署切换为自动脚本，请运行`pnpm vardock stop`，然后在`<home>/authority/profiles/operation-authority/cordis.patch.yml`中将`operation-control`行的`config.unattendedShell`设为`true`。保留已配置的执行后端：`backend: apple-vm`搭配`allowedTargets: []`，或`backend: docker`搭配`gatewaySocket`。设为`unattendedShell: false`可恢复逐一审查脚本。保持文件私有，权限为`0600`。
3. 运行`pnpm vardock start`。制御部在接纳请求前，将变更后的配置记录到见证服务。运行`pnpm vardock verify`以比对当前配置和操作证据。自动脚本没有批准卡；没有所有者规则的业务请求仍会显示批准卡。

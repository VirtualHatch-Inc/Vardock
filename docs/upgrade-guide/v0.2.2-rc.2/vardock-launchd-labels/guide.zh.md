---
kind: upgrade-guide
description: "Vardock 的 launchd 任务标签从 `io.deepseek.dsh.assistant-dev.<role>` 改为 `io.github.virtualhatch-inc.vardock.<role>`，新设置写入的控制服务主体为 `owner`。"
---

# Vardock launchd 任务标签

[English](guide.md) | 中文

## 变更

`pnpm vardock setup` 将见证服务、控制服务和 Web 的 launchd 任务命名为 `io.github.virtualhatch-inc.vardock.<role>`，并写入 `<home>/io.github.virtualhatch-inc.vardock.<role>.plist`。此前的设置使用 `io.deepseek.dsh.assistant-dev.<role>`。新设置还会在控制服务 Profile 的 `operation-control` 行中写入 `principalId: "owner"`，不再写入 `"assistant-dev"`。

受影响的是在此变更之前从开发仓库准备的部署。只要使用旧标签的任务已加载，或所选目录中有使用旧标签的任务文件，所有 `pnpm vardock` 命令都会拒绝执行，并打印下列步骤。

## 迁移

将 `<home>` 替换为部署目录，即 `$HOME/.vardock` 或你使用的 `--home`。

1. 卸载任务。更新检出之前，运行 `pnpm vardock stop --home <home>`。已更新检出时，运行 `launchctl bootout gui/$(id -u)/io.deepseek.dsh.assistant-dev.web`，再对 `.authority` 和 `.witness` 运行同样的命令；`launchctl print` 报告未找到的任务可跳过。
2. 重命名任务文件及其标签：

   ```sh
   cd <home>
   for role in witness authority web; do
     mv "io.deepseek.dsh.assistant-dev.$role.plist" "io.github.virtualhatch-inc.vardock.$role.plist"
     plutil -replace Label -string "io.github.virtualhatch-inc.vardock.$role" "io.github.virtualhatch-inc.vardock.$role.plist"
   done
   ```

   `plutil` 会保留文件的私有权限。
3. 不要修改 `<home>/authority/profiles/operation-authority/cordis.patch.yml`。其中的 `principalId` 是控制服务数据中授权及其用量限制、操作和工作记录以及 VM 工作区名称的键；修改它会使这些数据脱离部署。
4. 运行 `pnpm vardock doctor --home <home>`，再运行 `pnpm vardock start --home <home>`。确认启动命令打印 `Vardock is ready.`，**Assistant work** 显示此前剩余的预留次数，并且 `pnpm vardock verify --home <home>` 打印 `OK  Every compared event matches.`

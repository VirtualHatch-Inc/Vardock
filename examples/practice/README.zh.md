# 练习审批库存更新

[English](README.md) | 中文

本教程用一个小型本地库存服务演示审批、见证记录、确认业务结果，以及允许读取自动执行但让更新继续等待的规则。无需外部服务账户。你仍需满足 Vardock 的 macOS 前提条件并持有模型 API 密钥：请参阅[设置指南](../../packages/experimental/assistant/vardock/README.zh.md#prepare-the-checkout)，并阅读[安全说明](../../SAFETY.zh.md)。模型请求使用你的提供商，可能产生费用。

## 前提条件

在仓库根目录运行 `pnpm install`，并确认安装成功。端口 `19443` 必须空闲。如果已有 Vardock 部署在运行，请在第 2 阶段前使用该部署自己的 `--home` 停止它；launchd 标签只允许一个活动部署。

## 操作流程：六个阶段

1. **启动练习服务。** 在单独的终端中运行：

   ```sh
   cd examples/practice
   DSH_HOME="$PWD" pnpm exec node --import tsx/esm ../../apps/cli/src/bin.ts --profile practice
   ```

   应看到 `Practice inventory: https://127.0.0.1:19443` 和一条 setup 命令。首次启动在 `$HOME/.vardock-practice` 下创建适用于 `127.0.0.1` 的自签名 IP 证书及其私钥，文件权限为 `0600`。保持该终端运行。初始库存为 pencil 12、notebook 5 和 eraser 8；重启会重置库存和服务的结果凭证。

   生成的 `$HOME/.vardock-practice/authority.patch.yml` 包含两条 broker 路由、证书的绝对路径、读取的响应返回设置和更新的结果查询设置，不包含无人值守规则。

2. **准备、启动并连接 Vardock。** 在仓库根目录的第二个终端中复制输出的 setup 命令。将 `openai` 和 `<model-id>` 替换为与你的密钥对应的提供商路由和模型 ID：

   ```sh
   pnpm vardock setup --model-provider openai --model '<model-id>' --home "$HOME/.vardock-practice/deployment" --authority-patch "$HOME/.vardock-practice/authority.patch.yml" --permit-action list-items --permit-action set-quantity
   pnpm vardock start --home "$HOME/.vardock-practice/deployment"
   ```

   应看到 `Prepared Vardock`，随后打开 Vardock 页面。Setup 构建应用并在练习目录下准备独立部署，不发送模型请求。模型、到期时间和其他 authority 设置仍由 setup 选项决定，默认权限上限已经允许 `data.returnResponses`。

   在 **Plugins → Connections** 的模型条目中保存模型密钥。在 `list-items` 条目中输入 `practice-only-token` 并选择 **Save token**。这个固定值是刻意编造的公开值，不保护任何真实账户。两个库存操作共用 `PRACTICE_TOKEN`；选择 **Read current connections** 后，两项都应显示已配置。此时两项仍提示每次请求都等待审批。

3. **请求并批准更新。** 向入口发送以下内容：

   > In the connected practice inventory, set the pencil quantity to 7.

   应看到委派的工作和业务审批卡片。常规脚本在隔离 VM 中自动运行，外部请求则等待审批。如果 worker 先读取库存，该读取也会等待，因为此时尚无读取规则：检查并批准读取，再审阅更新。

   在更新的卡片中检查目标地址 `https://127.0.0.1:19443/quantity` 及保存的完整 JSON 正文：`sku` 应为 `pencil`，`quantity` 应为 `7`。仅在这些值匹配时选择 **Allow once**。请求随后应完成；本次审批仅适用于已保存的请求。

4. **检查记录、确认结果并验证。** 打开 **Plugins → Business records**，找到 `set-quantity`，确认目标地址和正文一致，并有审批、HTTP 结果及 **Witness receipt recorded**。如果入口尚未确认结果，在工作的操作详情中选择 **Check outcome**。再次读取记录后应看到 **A lookup confirmed it completed**。在第 6 阶段前确认此次更新，以免未解决操作的保留状态成为下次更新等待审批的原因。

   在 Vardock 运行时验证其比较的证据：

   ```sh
   pnpm vardock verify --home "$HOME/.vardock-practice/deployment"
   ```

   应看到 `OK  Every compared event matches.`。HTTP 响应成功与业务结果得到确认是两件事；此验证受[安全说明](../../SAFETY.zh.md#threat-model)所述限制约束。

5. **仅启用读取规则。** 返回 **Connections**，找到 `list-items`，将规则的条件和其他字段输入框留空，然后选择 **Send without approval**。应看到 **Approval rules saved**，且该操作显示 **Every request is sent without approval**。不要给 `set-quantity` 添加规则。

6. **观察自动读取和等待审批的更新。** 向入口发送以下内容：

   > Show me the inventory, then set the pencil quantity to 8.

   应返回包含 pencil 数量为 7 的列表，且读取没有业务审批卡片。数量更新为 8 的请求仍应在自己的审批卡片中等待。在 **Business records** 中，读取显示 **Sent without approval by a rule** 并保留见证凭证；更新显示 **Waiting for approval**。拒绝该更新即可结束练习，不再修改库存。

## 刚才发生了什么

第 1–2 阶段固定目标地址，并将 TLS 信任限定在这些路由；Connections 将令牌保存在 authority。第 3 阶段展示已保存请求的审批和权限上限。第 4 阶段区分 HTTP 交付、业务完成和见证证据。第 5–6 阶段展示所有者规则如何免去一项操作的审批，同时保留记录并让另一项操作继续等待。这些是[中介与审批保证](../../SAFETY.zh.md#approval-recovery-and-completion)，受[同一用户威胁模型](../../SAFETY.zh.md#threat-model)约束。

服务接受 `/items` 和 `/quantity` 上经过认证的 JSON POST；`/status` 为只读 GET，匹配更新的操作 ID 和载荷摘要。服务保留每次已接受更新的摘要，并将其操作 ID 用作稳定的服务凭证，直到进程退出。重启后，缺失的凭证无法确认先前结果。调查不确定结果时保留 authority 和 witness 记录，不要自动重发结果不确定的更新。证书有效期为 365 天；停止部署后删除练习目录可重新生成证书，但也会删除该部署的记录。

## 移除示例

先停止该部署，再在服务终端中按 Control-C：

```sh
pnpm vardock stop --home "$HOME/.vardock-practice/deployment"
```

如需丢弃示例，删除 `$HOME/.vardock-practice`。这将永久删除其证书和私钥、生成的补丁、部署、已保存的凭据及证据。共享 VM 和镜像的清理方法见[设置指南](../../packages/experimental/assistant/vardock/README.zh.md#remove-a-deployment)。移除此部署不会恢复或启动其他部署。

## 无密钥验证

在仓库根目录运行，确保端口 `19443` 空闲且练习服务尚未运行：

```sh
pnpm run build:native-system
pnpm exec vitest run --config examples/practice/vitest.config.ts
```

这个唯一的测试启动本示例配置，检查生成的路由设置，通过 setup 使用的叠加层加载器和补丁函数合成配置，并使用 operation-control 套接字测试设施、测试执行提供者及真实的 authority 和 witness 进程。它检查需要审批的更新、带见证记录的结果查询、通过规则自动执行且返回数量 7 的读取，以及仍等待审批的更新。它使用私有临时目录，不发送模型请求，不启动 launchd 任务，并等待其子进程退出。仍需有人使用真实模型执行这六个阶段，以验证委派和浏览器中的卡片。

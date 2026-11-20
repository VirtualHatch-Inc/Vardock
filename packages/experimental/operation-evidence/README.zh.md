---
description: "通过 Unix 套接字，在单独的见证进程中保存执行准入与结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-evidence

[English](README.md) | 中文

## 概述

在独立于智能体宿主和执行代理的进程中保存执行准入与结果；只有以自己的 OS 账户运行时，它在管理上才独立于它们。见证服务将每条事件提交到 SQLite 后才确认。如果回复丢失，可用稳定的事件 ID 找回回执。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

使用见证服务专用的操作系统账号运行独立的 `dsh` 配置档。确保智能体宿主和执行代理无法修改已安装的代码和配置。将 SQLite 数据库放在由见证账号所有、权限为 `0700` 的目录中。将套接字放在另一个由见证账号所有的目录中，禁止组写入和其他用户访问。仅授权执行代理访问。在 Linux 上，将套接字目录设为执行代理专用组、权限设为 `2750`，并将 `socketMode` 设为 `'0660'`。若代理或智能体宿主可访问以 root 运行的 Docker 守护进程，将见证服务部署在该进程的控制范围之外。

### 最小配置

挂载插件前，创建由见证账号所有的父目录。根据执行代理所需的权限设置 `socketMode`。

```yaml
- name: '@deepseek-ai/dsh-operation-evidence'
  config:
    socketPath: /run/dsh-witness/evidence.sock
    databasePath: /var/lib/dsh-witness/evidence.sqlite
    socketMode: '0660'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `socketPath` | 必填 | Unix 套接字绝对路径。 |
| `databasePath` | 必填 | SQLite 文件绝对路径。 |
| `socketMode` | `'0600'` | 默认只允许所有者访问，`'0660'` 同时授权所属组。 |
| `timeoutMs` | `5000` | 请求超时，单位为毫秒。 |
| `maxRequestBytes` | `65536` | 追加请求体的最大字节数。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-operation-evidence)说明字段校验规则。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节（点击展开）</summary>

[服务](src/index.ts)通过 Unix 套接字提供追加和查询操作。[客户端](src/client.ts)用事件规范化 JSON 的 SHA-256 摘要校验回执。消费者使用 `digestEvidenceEvent(event)` 计算同一回执摘要。`@deepseek-ai/dsh-operation-evidence/library` 导出 `EvidenceClient`、`digestEvidenceEvent` 和 `prepareOperationSocket`，后者是授权服务与网关共用的套接字路径准备。按同一 ID 追加相同数据时返回既有回执，追加不同数据时报告冲突。若追加结果未知，可按 ID 查询或重新提交相同事件。

`GET /events?after=<n>` 按提交顺序列出位置 `n` 之后已提交的事件，每页 50 条；首页传入 `0`。满页带有 `next`，即读取下一页时传入的位置。`EvidenceClient.list(after)` 读取一页，并拒绝摘要与事件不符的记录。列出操作不改变数据库。任何能连接套接字的进程都能列出全部事件，因此套接字权限同时决定谁能读取记录和谁能追加记录。

运行中的每个服务实例独占其 SQLite 数据库，并持有 `<socketPath>.lock` 文件上的锁。重启时保留该锁文件。服务崩溃后，若连接被拒绝，下一实例可回收服务账号所有的套接字。若启动时报告套接字被占用或无法确定其状态，请在重启前检查路径和监听进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [配置档](../../boot/app-boot/README.zh.md#profiles)——以独立组合启动见证服务。
- [执行容器](../execution-container/README.zh.md)——隔离的执行工作区。
- [助手](../assistant/README.zh.md)——委派任务与工作会话。

-----

<a id="model-experience"></a>
## 模型体验

无，因为见证服务通过私有套接字处理执行代理请求。

#### KV 缓存影响

调用方工具负责决定是否将回执纳入模型请求。

## 已知限制与推迟工作

<a id="known-limitations-and-deferred-work"></a>

- 数据库的保留和备份由见证服务管理员负责。服务保存执行代理提交的执行事实，摘要标识已保存的内容。
- 服务在 macOS 和 Linux 上使用 Unix 套接字。执行代理需要通过套接字读取和追加事件，并使用与见证服务兼容的请求上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文（点击展开）</summary>

无。

</details>

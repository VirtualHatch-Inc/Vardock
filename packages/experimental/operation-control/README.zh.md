---
description: "用共享授权控制隔离 Shell、文件传输、模型和 HTTPS JSON 操作，并通过单独的见证进程保存证据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-control

[English](README.md) | 中文

## 概述

为 Agent Host 提供隔离 Shell 操作、限定范围的文件传输、可选模型请求和 HTTPS JSON 操作的共享预算。Vardock设置以`unattendedShell: true`自动运行脚本；Broker请求等待所有者决定，除非固定的所有者规则放行。规则由控制服务评估，绝不由模型决定。笔记和计划仍需批准。每个许可都需要持久预留和独立见证进程的回执。响应丢失后可按操作ID查询。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

用三个独立的操作系统账户分别运行 Agent Host、操作授权服务和证据见证服务。构建、配置方案和父目录由运营方所有，Agent Host 无法写入。在授权服务配置方案中挂载[隔离执行提供方](../execution-container/README.zh.md)，并使用可信的预加载镜像。授予 Agent Host 访问操作套接字的权限。只有授权服务账户可访问见证套接字。

创建授权服务账户所有、权限为 `0700` 的 SQLite 目录。另建权限为 `2750` 的 Unix 套接字目录，由授权服务账户所有，并分配给专用 Agent Host 用户组。该用户组可遍历目录，套接字继承此用户组。授权服务将套接字权限设为 `0660`。套接字目录的父目录不得由 Agent Host 替换。

将审批套接字置于仅可信审批 Host 可访问的目录。只给有权提交人工决定和修改授权限额的进程所在的组授权。单账户开发配置下，同一账户运行的进程均可访问两个套接字。

### 最小配置

在授权服务账户下创建 `$DSH_HOME/profiles/operation-authority/package.json`。在此配置方案中安装所列软件包，版本与运行中的 Harness 一致。

```json
{
  "name": "operation-authority-profile",
  "private": true,
  "dsh": { "profile": { "bundles": [] } },
  "dependencies": {
    "@deepseek-ai/dsh-execution-container": "0.2.2-rc.1",
    "@deepseek-ai/dsh-operation-control": "0.2.2-rc.1",
    "@deepseek-ai/dsh-subprocess-local": "0.2.2-rc.1"
  }
}
```

在清单旁创建 `cordis.patch.yml`。此示例使用授权服务账户拥有的无根 Docker 守护进程。将授权到期时间设为所需的 UTC 纪元毫秒数。将示例路径和镜像替换为运营方实际配置的值。

```yaml
- insert:
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: isolated-execution
      name: '@deepseek-ai/dsh-execution-container'
      config:
        backend: docker
        dockerSocket: /run/user/1001/docker.sock
        image: dsh-execution:local
    - id: operation-control
      name: '@deepseek-ai/dsh-operation-control'
      config:
        principalId: agent-host
        scopeId: offline-shell
        socketPath: /run/dsh-authority/operation.sock
        approvalSocketPath: /run/dsh-approval/decision.sock
        databasePath: /var/lib/dsh-authority/operation.sqlite
        evidenceSocketPath: /run/dsh-witness/evidence.sock
        grantExpiresAt: 1798761600000
        maxOperations: 20
        assistant:
          mainSessionId: assistant-main
          permissions:
            exec: true
            brokerActions: []
```

先启动[见证配置方案](../operation-evidence/README.zh.md)，再用授权服务账户运行 `dsh --profile operation-authority`。将 Assistant 配置方案的 `DSH_OPERATION_SOCKET` 设为操作套接字路径，将 `DSH_APPROVAL_SOCKET` 设为审批套接字路径。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `principalId` | 必填 | 运营方为可访问套接字的调用方指定的主体。 |
| `scopeId` | 必填 | 运营方为隔离工作区指定的命名空间。 |
| `socketPath` | 必填 | 授权 Agent Host 使用的 Unix 套接字。 |
| `approvalSocketPath` | 配置 `assistant` 或启用 `broker` 时必填 | 用于审批决定和所有者授权设置的独立 Unix 套接字。 |
| `databasePath` | 必填 | 本地文件系统上由授权服务账户所有的 SQLite 文件。 |
| `evidenceSocketPath` | 必填 | 单独见证服务的套接字。配置变化后的每次启动都要等见证服务确认其配置记录。 |
| `grantExpiresAt` | 必填 | 初始 UTC 到期时间，以纪元毫秒表示。 |
| `maxOperations` | 必填 | 数据库初始的累计预留次数上限。 |
| `maxFileBytes` | `8388608`（8 MiB） | 单个导入文件或导出快照的解码字节上限。最高可设为 32 MiB。 |
| `requestTimeoutMs` | `10000` | 发送请求的时限。 |
| `evidenceTimeoutMs` | `5000` | 等待见证确认的时限。 |
| `model.provider`、`model.model` | 省略 | 允许一个 Provider 路由和模型 ID 使用同一预算。授权服务配置方案必须挂载注册该路由的 LLM 适配器。 |
| `model.credentialRef` | 省略 | 该适配器读取 API 密钥所用的凭据引用。设置后，所有者可在 Assistant 中保存该密钥。 |
| `assistant.mainSessionId` | 省略 | 允许从此入口委任，并向同一入口配送。省略则拒绝这两类操作。 |
| `assistant.permissions` | 配置 `assistant` 时必填 | `exec`、精确的 `brokerActions` 允许列表及可选文件权限的上限。 |
| `assistant.permissions.data` | 省略 | 同时启用 `discloseToModel` 和 `discloseToUser` 后，`import` 和 `export` 分别允许对应方向的传输。`returnResponses` 允许将业务响应文本返回给工作脚本。提供 `data` 时五个字段均为必填。省略则拒绝文件传输和响应返回。 |
| `broker` | `[]` | 已挂载代理提供方的服务名，例如 `['operationBroker', 'operationBrokerMcp']`。列表非空时，允许运行中的 Shell 操作请求已配置的操作。授权服务选择列出所请求操作的提供方，两个提供方列出同一操作时拒绝启动。 |
| `unattendedShell` | `false` | 无需人工决定即可接受 shell 提案；业务请求等待决定，除非所有者规则放行。Vardock设置写入`true`；`--review-scripts`写入`false`。要求执行后端支持业务请求：未配置 CONNECT 目标的 Apple VM，或设置了 `gatewaySocket` 的 Docker。更改此项会使尚未使用的批准和许可失效。 |
| `unattendedBrokerActions` | `[]` | 无需人工决定即可发送匹配业务请求的规则。每条规则指定 `assistant.permissions.brokerActions` 中的一个 `action`，可用 `match` 指定请求体顶层字段的值，并用 `allow` 列出请求体还可以包含的其他顶层字段名（最多 64 个）。提供 `match` 时必须提供 `allow`；用 `allow: []` 表示不允许其他字段。带 `match` 或 `allow` 的规则只适用于 `JSON.stringify` 紧凑格式的 JSON 对象请求体。不检查 `allow` 中所列字段的值。同时省略 `match` 和 `allow` 时，规则覆盖该操作的所有请求体。每个操作最多 64 条规则。这些规则在所有者第一次经见证修改规则之前适用；此后所有者的规则取代它们，重启或修改配置档后也是如此。任何规则都不放行[结果尚未确认的请求的重复请求](#repeated-business-requests)。[修改无人值守规则](#edit-unattended-rules) |

可通过 `OperationControlClient.status(id)` 查询操作，或通过操作套接字向 `POST /status` 发送 JSON `{"id":"<operation UUID>"}`。查询会重试获取待确认的见证回执。提案响应丢失时，用相同请求键和载荷重发。决定是否请求新的工作前，先检查 `unknown` 状态的结果。

如需只读概览，Host 可调用 `HandoffControl.overview` 查看入口或工作 Session。指定工作 ID 后，统计范围限于该次委任，而预算仍涵盖数据库中的所有预留。授权到期后仍可读取概览。概览省略操作载荷，并将等待结果证据的操作列为结果不确定。当 Session 可能保留导入的所有者文件，且当前权限上限、该 Session 当前的工作授权或指定委任的授权缺少任一披露权限时，其 `disclosesImportedData` 为 `false`；Assistant 在向入口模型展示工作报告之前读取此值。

较新的操作成功后，概览会清除最近一次问题的提示。较早的未知结果仍保留记录并计入统计；后续请求成功不会解决它们。

### 配置变化在启动时经见证

每次启动时，授权服务将其配置的指纹与数据库上次记录的指纹比较。两者不同时（包括新数据库的首次启动），它在处理任何请求之前向见证服务发送一个 `configuration` 事件。该事件写明主体和范围、之前和新的授权修订号（新数据库的 `previousRevision` 为 `null`），以及 `configuration` 对象：带有 `mainSessionId` 的 `assistant.permissions` 权限上限；合并后的代理指纹，以及每个获准动作的 ID、凭据引用名称和是否返回其响应；`unattendedShell`；配置文件中的 `unattendedBrokerActions`；模型提供方、模型 ID 和凭据引用名称；执行后端指纹；以及配置文件中的 `grantExpiresAt`、`maxOperations` 和 `maxFileBytes`。它不含凭据值、套接字路径或端点。事件 ID 是事件内容的摘要，因此存储状态和配置相同的启动会重复同一事件，见证服务返回其已有回执。

授权服务在同一事务中保存回执并采用新的修订号；数据库已记录其指纹的启动不发送任何事件。在见证服务确认该事件之前，授权服务虽然监听，但以 `configuration-evidence-unavailable` 拒绝两个套接字上的所有请求，且每个请求都会重试同一事件，因此见证服务可达后授权服务无需重启即可恢复。如果见证服务拒绝该事件，例如事件超过授权服务见证客户端 64 KiB 的请求上限，启动以 `configuration-evidence-refused` 失败；请减少获准的代理动作或缩短无人值守规则。由早期版本创建的数据库在使用此版本首次启动时记录其配置；只有指纹不变时才保留其修订号。`HandoffControl.grantSettings` 以 `configuration` 返回该回执。

准入或配置等待见证服务确认时，所有者提示会指出见证服务未确认记录，说明此请求未运行或发送任何操作，并提示 Vardock 所有者运行 `pnpm vardock doctor`。见证服务恢复后，授权服务会自行恢复；已执行但缺少结果证据的操作仍保持结果未明。

见证服务保存每次启动起生效的配置。它不保存配置文件本身、在下次启动前被撤销的配置文件编辑，也不保存本插件配置以外的设置，例如授权服务配置文件中的其他插件以及 Host 和 Web 配置文件。

### 修改授权限额

通过认证的所有者可在 Assistant 中修改累计预留次数上限和到期时间。Host 的交接提供方通过 `approvalSocketPath` 调用 `HandoffControl.grantSettings` 和 `HandoffControl.updateGrant`。修改时须提供读取设置时返回的修订标识。若修订标识已过期，刷新设置后再决定是否保存。

授权服务验证见证服务的回执后才应用修改。两个限额均保存在授权服务数据库中，重启后继续生效。此前的每次预留仍计入预算，上限低于已预留次数时，剩余额度为零。到期时间设为过去后，将拒绝新的准入。见证服务不可用时，原限额继续生效。如果响应丢失，重新读取设置以确认结果。

生效的修改会使尚未消费的批准和许可失效。已经打开的审批卡片仍可关闭。授权服务拒绝失效的审批，概览也将其排除在待审批数量之外。业务检查显示记录中的状态，并在取消前报告 `revision-mismatch`。如果业务审批因修订变更而失败，代理请求会取消，父脚本可继续运行。已消费的操作保留记录状态，并可继续记录其结果。此前已获见证的工作仍按自身权限运行，新操作的预留受当前限额约束。仍可用原操作 ID 查询未知结果。

### 设置连接凭据

通过认证的所有者可在 Assistant 中为获准的代理操作保存 Bearer 令牌，并保存 `model.credentialRef` 指定的 API 密钥。Host 的交接提供方通过 `approvalSocketPath` 调用 `HandoffControl.brokerConnections` 和 `HandoffControl.setBrokerConnection`。列表包含每个获准的操作、用法说明、凭据引用、是否已保存值、是否返回响应，以及适用于该操作的无人值守规则。列表还报告 `unattendedShell`；设置了 `model.credentialRef` 时，还报告模型路由及其凭据状态。任何读取都不返回值。

授权服务将令牌写入自身的凭据提供者，键为该操作的凭据引用。授权服务拒绝 Assistant 授权之外的操作，也拒绝不是 Bearer 令牌的文本。Host 只转发该值，不保留。授权服务按到达顺序逐一处理凭据修改。每次写入或删除之前，授权服务向见证服务发送一条事件，其中指明操作或模型路由以及是否已保存值，不包含该值；见证服务未确认时，授权服务拒绝此修改。该事件记录的是写入之前已接受的所有者修改请求，而不是写入结果：如果之后写入失败，请求返回错误，见证服务仍保留该事件。此修改不改变授权修订版本。代理为每个请求解析凭据，因此下一次请求使用新值。

<a id="edit-unattended-rules"></a>
### 修改无人值守规则

所有者可通过 `HandoffControl.setBrokerConnection({ action, unattended, revision })` 替换一个获准操作的无人值守规则。每条规则使用 `unattendedBrokerActions` 中的 `match` 和 `allow` 字段；提供 `match` 时必须提供 `allow`。在连接编辑器中，填写条件但将其他字段留空会保存 `allow: []`。`revision` 是 `brokerConnections` 返回的值；授权服务以 `revision-mismatch` 拒绝过期的值，以 `broker-action-unavailable` 拒绝 Assistant 授权之外的操作，并在另一项限额或规则修改等待见证时以 `grant-update-in-progress` 拒绝修改。授权服务将每个操作的规则与该操作当前的路由摘要一起保存；路由摘要由 Broker 提供方根据该操作的请求发往何处、返回什么内容生成。[路由摘要](../operation-broker/README.zh.md#understand-the-implementation) 见证服务确认 `unattended-rules-update` 事件后，授权服务才应用修改；该事件包含每个已保存的操作及其路由摘要和规则，以及被替换的修订版本；见证服务未确认时，原规则继续生效。授权服务将规则与授权限额分开保存在自身数据库中，因此修改规则不会固定限额，修改限额也不会改变规则。

从第一次修改起只适用所有者的规则；修改配置档（包括修改 `unattendedBrokerActions`）不会改变它们。第一次修改还会保存配置档中其他每个有规则的获准操作的规则，各自使用该操作当前的路由摘要。每次修改只替换被修改操作的条目。它保留其他每个已保存的条目及其路由摘要（包括规则已停用的条目），并删除授权不再允许的操作的条目。空列表按原样保存：该操作的每个请求都等待决定。一个操作的已保存规则恰好在其当前路由摘要等于已保存摘要时适用。否则该操作的请求都不会在没有决定的情况下发送，`brokerConnections` 为该操作报告 `routeChangedSinceRulesSaved: true` 且不列出其规则，其他操作的规则不受影响。已保存的规则留在数据库中，运营者恢复保存时的路由后会再次适用。该操作的下一次修改在其当前路由摘要下保存新列表，从空规则开始。

修改会改变授权修订版本。路由改变会改变其提供方的指纹，进而改变授权服务指纹，启动时替换授权修订版本。两种情况下尚未消费的批准和许可都不再有效。Agent 无法发出此请求：它只在审批套接字上提供。

### 将工作绑定到主体和权限

可信宿主机套接字代表配置的 `principalId`。Assistant 仅接受 DSH 已认证所有者的交互修改，并通过配置的入口委派工作。提示词和工具参数均不提供主体身份。不同所有者应使用独立的宿主机与授权服务配置；共享入口不提供多用户隔离。

显式设置 `assistant.permissions`。`exec` 允许在工作会话自己的 VM 中运行脚本；`brokerActions` 列出工作可请求的外部操作。空列表不允许任何业务发送，也不需要 Broker。列出的每个操作都必须由已配置的 Broker 提供；否则启动会列出缺失的操作，并提示添加其路由或将其从权限中移除。添加代理路由不会将其加入权限列表。现有模型配置仍是唯一可用的模型路由。

获得见证的委派将工作 ID、主体、工作会话、前一项工作和解析后的权限绑定。请求权限必须在根权限上限内；继续工作会话时还必须在前一项工作的权限内。新工作必须声明权限；省略权限时授权服务以 `work-permission-required` 拒绝。继续工作省略权限时保留前一项工作的授权，并随之后降低的根权限上限收窄。之后提高根权限上限不会扩展现有工作授权。工作区仍绑定到会话；继续工作保留该工作区，新工作会话使用独立工作区。

授权服务在准入、人类批准和执行前检查当前工作及权限上限。批准不能增加能力或代理操作。继续工作会替换该会话的当前工作，因此较早的未消费许可不能借用后继工作的授权执行。历史结果继续保存。显式工作授权之前的记录仍可查看，但不能推断出权限；需要提交新的带权限请求。

### 传输工作文件

使用支持文件传输的隔离执行提供方。每次传输都要求当前根权限上限和工作授权同时允许对应传输方向及两项披露权限。模型可能通过命令输出接收文件内容，所有者也可能通过工作报告接收这些内容，因此两项披露权限都必需。

经过见证的委派最多可绑定所有者消息中的八个附件引用。授权服务只将符合已授权引用和 SHA-256 摘要的字节导入工作区内的 `input/<digest>/<safe name>`。继续工作时保留原有输入范围及工作区。更换输入文件时，请创建新工作。可能保留导入字节的会话必须持有当前有效的披露权限，才能继续运行脚本、调用模型或访问代理。[在 Assistant 中选择输入文件](../assistant/README.zh.md#use-this-package)

授权服务保留大小受限的导出快照，供所有者入口读取。见证回执绑定工作、接收方、字节数和摘要。取得见证回执且两项披露权限仍有效时，宿主机可读取快照。重启后从授权服务数据库恢复已保留的快照。普通操作状态只返回文件元数据。每次获准的传输占用一次预留额度。撤销披露权限后，已经交付的副本仍然存在。

### 审批 Shell 命令

配置 `approvalSocketPath` 且设置 `unattendedShell: false` 后，Shell 提案返回 `pending-approval`，并提供用于审批的准确脚本、来源会话、授权修订和载荷摘要。Assistant 显示脚本并标明隔离的 `/workspace`。可信 Host 通过审批套接字调用 `OperationControlClient.decide`，传入操作 ID、修订、摘要及 `approve` 或 `deny`。操作套接字处理提案、执行、查询和取消请求。

批准将单次操作绑定到已审阅的脚本。授权服务记录批准并收到见证服务的准入回执后才发放许可。拒绝会取消预留，并记录原因为 `approval-rejected` 的撤销事件。拒绝和取消的预留仍计入授权预算。模型调用和 Assistant 交接使用各自已有的授权。

<a id="enable-https-business-requests"></a>
### 启用 HTTPS 业务请求

在授权服务配置方案中挂载代理和凭据提供方。为 operation-control 条目添加 `inject: ['operationBroker']`，使它等待代理服务就绪。在该条目的 `config` 中设置 `broker: ['operationBroker']` 和 `approvalSocketPath`。要挂载多个提供方，请在 `inject` 和 `broker` 中都列出每个提供方的服务名。使用 Apple VM 执行提供方并设置 `allowedTargets: []`，或使用设置了 `gatewaySocket` 的 Docker 执行提供方。配置原始 CONNECT 目标或缺少网关套接字时，授权服务拒绝启动代理模式。运营方为每项操作配置固定的 HTTPS `POST` 目标地址及 Bearer 凭据引用。空路由表拒绝所有操作。[代理配置](../operation-broker/README.zh.md#use-this-package)

在已准入的 Shell 执行中，使用 `DSH_BROKER_URL` 中的地址和 `DSH_BROKER_TOKEN` 中的请求令牌提交操作 ID 和 JSON 请求体。此令牌仅在当前执行期间有效。授权服务将父执行 ID 和提案键交给代理，再将准备好的请求预留为单独的操作。审批卡片显示请求的操作、请求方法和目标地址，以及完整的发出 JSON。代理还可根据同一份已保存的请求提供易读的预览。许可消费后，代理在授权服务中解析外部 Bearer 凭据。

此示例假定运营方已配置 `create-record` 操作。请在工作会话的 `exec` 脚本内运行。

```sh
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto'

const { DSH_BROKER_URL: url, DSH_BROKER_TOKEN: token } = process.env
if (!url || !token) throw new Error('No active broker request capability.')

const requestKey = randomUUID()
let response, result
try {
  response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestKey, action: 'create-record', body: '{"title":"Example"}' }),
  })
  result = await response.json()
} catch {
  throw new Error(`No broker reply for ${requestKey}. Inspect the authority record before submitting again.`)
}
if (!response.ok || !Number.isInteger(result?.status)) {
  console.error(JSON.stringify(result))
  process.exitCode = 1
} else {
  console.log(JSON.stringify(result))
}
NODE
```

本地网关可在 HTTP `200` 响应中返回结构化错误，请检查 JSON 中是否有数字 `status` 或布尔值 `toolError`。已有见证的响应包含 `id`、`receipt`，以及 `status`（远端的 HTTP 状态码）或 `toolError`（MCP 服务器是否将工具结果标记为错误）。路由配置为返回响应的操作，其回复还以 `body` 携带响应文本，或以 `bodyOmitted` 说明其缺失的原因。仅当根权限上限和工作授权都允许 `data.returnResponses` 时才返回文本；否则请求仍会发送并记录，`bodyOmitted` 为 `not-permitted`。未记录该字段的授权不返回响应文本。授权服务将该文本交给等待中的脚本而不保留；回复丢失后无法再次读取。经见证的结果以 `responseDigest` 记录该文本的 SHA-256，或以 `responseOmitted` 记录原因。请向目标服务核实业务是否完成。响应或回执不可用时，重新提交前请检查授权服务记录。授权服务和代理不会自动重试发送。

<a id="repeated-business-requests"></a>
### 重复业务请求

如果同一授权下较早的业务请求结果尚未确认，而新业务请求发往同一操作，无人值守规则不会放行新请求。除非较早的请求在发送前已取消、代理报告其未发送，或经见证的状态查询确认其成功或失败，否则视为结果尚未确认。这包括等待决定或准入的请求、正在发送的请求、结果未知的请求，以及收到响应但业务完成尚未确认的请求。匹配范围覆盖该授权下的所有会话和工作委任，因此续作或另一个工作 Agent 都无法绕过。重复请求等待所有者决定；其审查数据在 `repeats` 中带有较早的操作 ID，Host 的审批卡片会说明批准可能重复其效果。没有规则覆盖的请求也带有同样的提示。脚本得到通常的等待审查行为。授权服务在预留新请求的同一数据库事务中查找较早的请求，因此两个发往同一操作的并发请求不会都在无人决定的情况下被放行。

### 核对业务操作

提交操作前，配置代理路由的 `reconciliationEndpoint`。审批将此查询目标与原始请求一起绑定。该端点必须实现[代理的回执协议](../operation-broker/README.zh.md)。未记录查询目标的历史操作不能通过猜测路由取得可验证的结果。

在入口调用 `inspect_business_operations`，传入工作会话的 `session_id`。设置 `reconcile: true` 后，会对返回页中每个符合条件且尚未确定结果的操作执行一次只读查询。将返回的 `next` 值作为 `after` 传入，即可查看下一页。此工具绝不重发原始 POST，并通过已有工具历史保存结果。

Host 可调用 `HandoffControl.businessOperations` 查看一次委任的业务记录。检查读取已保留的证据。`HandoffControl.reconcile` 为符合条件的操作请求查询，或补全已有观测的见证。

`businessCompletion` 区分 `unconfirmed`、`pending`、`succeeded` 和 `failed`。查询通过见证服务保留的匹配外部回执确认成功或失败；所有者判定标记为 `source: owner`，带有见证回执，但没有外部 `receiptId`。记录不存在、响应无效或连接丢失均不能证明失败。HTTP 状态和 Agent 报告均不能证明业务完成。后续查询确认成功后，原始发送状态及观测结果仍可读取。经见证的 `succeeded` 或 `failed` 结果使无人值守规则可以再次放行发往该操作的请求；其他任何结果都使发往该操作的请求继续等待决定。[重复请求](#repeated-business-requests)

请求经所有者批准或由无人值守规则放行、见证服务持有其准入记录，且发送以响应或未知结果结束时，才可查询；被拒绝的请求从未发送，没有查询。查询前，授权服务检查当前主体和适用的工作权限；代理在发送 GET 前将保存的目标与当前路由核对。当前 POST 大小限制不重新验证已经发送的请求体。查询不另占执行额度。并发调用共享同一次查询；已确认的最终结果直接返回，不再发送外部请求。每次尝试在 GET 前保留意图，在发布结果前保留观测。重启后，显式检查可请求再次只读查询；如果观测已保存，则只重试其见证回执。系统不自动轮询或重发。

<a id="read-business-records"></a>
### 读取业务记录

Host 通过 `HandoffControl.businessRecords(after)` 读取所有 Session 的业务请求。Unix 提供方调用 `OperationControlClient.businessRecords(after)`，该方法在审批套接字上发送 `POST /business-records`，JSON 为 `{"after":"<operation UUID>"}`；读取最新记录时省略 `after`。操作套接字以 `approval-forbidden` 拒绝该请求。每页最多列出 50 条记录，按预留顺序从新到旧排列；若下一条记录会超出 1 MiB 的响应上限，该页提前结束；`next` 是读取更早记录的游标。`after` 未指向任何业务记录时，请求以 `business-cursor-invalid` 被拒绝。每条记录包含业务状态字段、`method`、`endpoint`、存在时的 `tool`、请求的原文 `body`，以及存在时的 `workId`。该读取不修改任何记录，也不请求证据。

在业务记录和业务状态中，`approval` 为 `approved` 或 `denied` 时表示人工决定，为 `unattended` 时表示无人值守规则在没有人工决定的情况下准入了该请求。请求等待决定期间，以及请求在作出决定前被取消后，该字段不存在。授权服务升级一个在其记录 `unattended` 之前写入的数据库（架构版本 10 或更早）时，会为每个没有决定、正在等待准入证据或持有准入回执的业务请求设置该值；在已由较早构建升级到版本 11 的数据库中，曾等待准入证据的请求保持已取消状态，且没有 `approval` 值。这类数据库无法区分在取得准入回执前被取消的请求与在作出决定前被取消的请求，因此两者的 `approval` 都保持不存在。

在**业务记录**页面，对于发送后收到响应或结果未知、且结果尚未确认的操作，所有者可选择**我已核实：已发生**或**我已核实：未发生**。见证服务确认判定后，该行会将所有者标为来源。MCP 操作和没有查询端点的 HTTPS 路由也可使用。原始发送记录保持不变，该操作对同一动作的阻止会解除，派生的工作结果计数与查询确认后一样更新。已取消、未发送、正在运行或结果已确认的操作不能接受所有者判定。

`HandoffControl.resolveBusiness({ id, kind })` 和 `OperationControlClient.resolveBusiness({ id, kind })` 通过审批套接字发送 `POST /resolve-business`，其中 `kind` 为 `succeeded` 或 `failed`。操作套接字以 `approval-forbidden` 拒绝它；没有模型或工作方工具提供此功能。授权服务将判定保存在对账观测记录中，获取回执后判定才生效。未经见证确认，完成状态仍未确认，阻止仍然有效；重试前请重新读取记录。后续对账请求可重试获取已保存观测的回执，无需外部查询。授权数据库使用模式版本 13；较早的记录保持不变，旧版授权服务无法重新打开它。

### 与见证服务比对记录

`@deepseek-ai/dsh-operation-control/library` 导出 `OperationControlClient` 和 `verifyRecords`。`verifyRecords(approver, evidence)` 通过 `EvidenceClient.list` 读取全部见证事件，并将每个操作的准入、结果和撤销事件与授权服务保存的对应回执进行比对。它通过 `OperationControlClient.receipts(ids)` 获取这些回执：该方法在审批套接字上发送 `POST /operation-receipts`，JSON 为 `{"ids":["<operation UUID>", ...]}`，最多 50 个 ID；操作套接字以 `approval-forbidden` 拒绝该请求。回复列出授权服务已有的每个所请求操作的 `admission`、`outcome` 和 `revocation` 回执，并省略不存在的操作。调用方需要同时能访问审批套接字和见证套接字。

每个报告的问题都指明一个见证事件 ID。`operation-missing` 表示授权服务没有见证服务所持有操作的记录。`receipt-missing` 表示授权服务有该操作但没有这条回执；授权服务在见证服务确认事件之后、自身提交回执之前停止时也会出现这种情况，重启后授权服务将该操作结算为未知或已取消。`digest-mismatch` 表示授权服务的回执所指内容与见证事件不同。结果报告每个问题，但不判断属于哪种原因。见证服务返回的页面 `next` 不大于读取位置时，比对以错误停止。比对还通过 `OperationControlClient.grant()` 读取配置回执，并与见证服务中具有该 ID 的事件核对；`event-missing` 表示见证服务没有该事件，结果将其列在其他问题之后。早期配置、授权限额、无人值守规则、凭据变更和业务查询的事件没有可比对的回执；结果将其计入 `other`。如果授权服务的配置记录仍未确认，verify 发出的首个特权请求会在见证服务确认后将其定案；除此之外，比对不修改任何内容。

### 启用模型请求

在授权服务配置方案的依赖中添加 `@deepseek-ai/dsh-llm` 和一个 LLM 适配器，并在该方案中挂载两个插件。使用 API Provider 时，挂载 [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) 并配置 `openai` 等路由，其 `apiKeyEnv` 指向授权服务凭据存储或进程环境中的凭据。使用 Local Codex 时，挂载 [`@deepseek-ai/dsh-llm-codex`](../llm-codex/README.zh.md)，其路由为 `codex-local`、模型为 `default`，并使用授权服务账户登录 Codex。在授权服务中设置 `model.provider` 和 `model.model`，然后在 Agent Host 上挂载 `@deepseek-ai/dsh-operation-control/model-agent`，为其配置相同的 `provider`、`model` 和授权服务的 `socketPath`。为 Host 的 Session 选择该路由和模型。代理接受此路由的 Session 请求，Host 无需访问授权服务的模型凭据。

Host 代理的可选 `timeoutMs` 默认为 `180000`。使用此代理时，请禁用模型生成的 Session 标题。标题生成所需的控制选项需要其他路由。

### 启用委任和响应配送

在授权服务中设置 `assistant.mainSessionId`，在 Host 上挂载 `@deepseek-ai/dsh-operation-control/handoff`，配置 `socketPath` 和可选的 `timeoutMs`。Assistant 覆盖层会挂载此提供方。抽象 `HandoffControl` 服务是替换点：其 `release` 方法在返回前必须将来源、目标、内容和稳定请求键与当前授权及持久见证回执绑定。

授权服务将准确的交接内容保存为持久发件记录。委任发布授权 Host 接纳该工作；配送发布授权公开已缓冲的入口响应。回执确认此次发布，而非工作完成、浏览器接收或业务结果。同一键无法发布不同内容。重新检查发布无需额外预留预算，但必须使用当前配置修订且授权仍在有效期内。所有者续期后，Host 可用原请求键恢复已消费的交接发布。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节（点击展开）</summary>

[存储](src/store.ts)将准确的脚本或投影后的模型请求与 Session、配置修订和预算预留绑定。[授权服务](src/authority.ts)在调用隔离执行提供方或 Local Codex 适配器前检查当前授权并提交消费状态。Shell 观测结果包含退出状态和确认的容器停止。模型观测结果包含完整的响应流。授权服务保留此响应流，待见证服务记录其摘要和已有用量后才返回。命令即使返回非零退出码或丢失响应，也可能已经影响工作区。

重启时，未获答复的 Shell 审批继续等待。已记录的 Shell 批准可以恢复准入回执，仍需显式请求执行。授权服务取消未消费的代理请求，因为其父 Shell 执行已经结束。已记录消费但没有观测结果的操作变为 `unknown`。已有观测结果的操作可恢复其见证回执。配置变化在见证服务确认其配置记录后推进持久修订号，使较早的批准和未消费许可失效；所有者的无人值守规则仍然保存，每个操作的规则按其路由摘要保存。[套接字恢复方式和锁文件](../operation-evidence/README.zh.md#understand-the-implementation)

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [配置方案](../../boot/app-boot/README.zh.md#profiles) — 启动独立的 Harness 组合。
- [执行容器](../execution-container/README.zh.md) — 选择并配置隔离工作区后端。
- [证据见证](../operation-evidence/README.zh.md) — 运营单独的回执存储。
- [Assistant](../assistant/README.zh.md) — 委派工作并检查 Session 结果。

-----

<a id="model-experience"></a>
## 模型体验

### 执行结果

#### What the model sees

Agent Host 的 `exec` 工具返回观测到的退出状态和输出、操作 ID，以及见证摘要。Shell 审批被拒时，工具返回带操作 ID 的失败结果。如果脚本打印代理回复，模型可在工具输出中看到远端 HTTP 状态和回执，或代理错误码。

#### Token effect

每个操作 ID 和见证摘要都会向 `exec` 结果添加文本。

#### KV Cache effect

操作结果会给下次模型请求添加工具结果。

### 业务检查

#### What the model sees

入口的 `list_business_actions` 工具返回 Assistant 授权允许的代理操作及各提供方的用法说明。入口的 `inspect_business_operations` 工具返回所选工作会话的发送状态、业务完成情况、回执标识及见证证据。查询错误仍表现为未确认结果。[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-operation-control)

#### Token effect

每项返回的操作向工具结果添加状态及证据。

#### KV Cache effect

检查结果成为入口下次模型请求中的工具消息。

### 模型请求

#### What the model sees

授权服务通过为所配置路由挂载的 LLM 适配器发送投影后的文本历史和可用的 Harness 工具模式。

#### Token effect

中介过程不添加模型可见文本。授权服务将每个已准入的请求计为一次操作。

#### KV Cache effect

请求投影和缓存行为由所挂载的 LLM 适配器负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 授权涵盖隔离的 `exec`、代理请求、受工作授权约束的文件传输、配置的模型路由，以及配置的入口委任和响应发布。模型许可涵盖一次模型请求。工作 Agent 向入口返回的结果通知和检查 API 仍遵循各自的访问控制。
- 套接字访问对应运营方指定的一个主体。宿主机负责选择可信会话身份。Assistant 操作必须属于入口或授权服务签发的工作绑定；工作共享部署预算。每个持久预留都计入预算，包括已取消和结果未知的操作。
- 见证服务在自己的进程和数据库中保留授权服务报告的事实；只有以自己的 OS 账户运行时，它在管理上才独立于授权服务。回执表明事件已保留并可核对完整性，工具结果报告执行器的观测。业务完成需要已配置查询服务的回执及其独立保留。
- 配置记录涵盖每次启动起生效的配置，而非配置文件本身。在下次启动前被撤销的配置文件编辑不留下记录；记录也不包括本插件以外的插件、Host 和 Web 配置文件，以及代理指纹之外的代理路由端点。
- 授权数据库包含投影后的模型输入、完整响应、准确的交接载荷、原样代理请求体及导入和导出的文件字节。请将访问权限限制在授权服务账户。
- Broker 提供方中改变其操作发送或返回内容的限制（例如 `maxBodyBytes`）属于这些操作各自的路由摘要。修改它会停用所有这类操作的所有者无人值守规则，直到所有者再次保存或运营者恢复该限制。
- 套接字将普通请求限制为 256 KiB，普通响应限制为 1 MiB，其中包含协议字段。`/propose-file` 上传和 `/read-export` 下载采用各自的上限，包含 Base64 编码和协议字段。模型响应超过可用空间时，结果记为未知。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作备注（点击展开）</summary>

软件包测试在同一个测试 UID 下使用独立的 Unix 套接字和 SQLite 存储。部署隔离取决于账户、目录和守护进程的所有权配置。

</details>

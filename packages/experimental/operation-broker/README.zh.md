---
description: "使用操作授权服务持有的凭据，向运维人员配置的 HTTPS 路由和 MCP 工具发送经批准的 JSON 请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-operation-broker

[English](README.md) | 中文

## 概述

准备内容确定的 HTTPS JSON 请求，交由操作授权服务审核，并在批准后发送。配置了状态端点的路由可以查询业务结果，无需重新发送请求。运维人员为每项操作指定端点和 Bearer 凭据引用。调用方只提供操作 ID 和 JSON 请求体。本包的第二个提供方在同样的审核下调用运维人员选定的远程 MCP 服务器工具。

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

在操作授权服务的 `dsh` 配置档中同时挂载代理、凭据提供者和操作授权服务。凭据提供者及其凭据值由该账号持有。运维人员配置目标地址和凭据引用前，使用 `routes: []`。

<a id="example-route"></a>
### 路由示例

将示例端点替换为包含路径的规范 HTTPS URL。在操作授权服务的凭据提供者中配置该引用对应的 Bearer 令牌。没有只读状态端点的路由省略 `reconciliationEndpoint`。通过 `description` 告知发起请求的模型该操作的用途及其 JSON 请求体。该文本最多 2000 个字符，并原样提供给模型。发起请求的工作环境需要响应文本（例如读取操作）时，在路由上设置 `returnResponse: true`。授权服务仅将该文本返回给授权允许 `data.returnResponses` 的工作，文本可能由此到达模型。代理返回不超过 `maxResponseBytes`（默认 `32768`）的完整 UTF-8 文本；响应过大、不是 UTF-8、被中断或回显凭据时省略文本，但仍报告状态码。

```yaml
- name: '@deepseek-ai/dsh-operation-broker'
  config:
    routes:
      - action: create-record
        description: 'Create one record. The body is {"name": string}.'
        endpoint: https://records.example.com/api/records
        reconciliationEndpoint: https://records.example.com/api/records/status
        credentialRef: RECORDS_API_TOKEN
```

`timeoutMs` 默认 `15000`，涵盖从查找凭据到收到 POST 响应头或完整状态响应的过程。`maxBodyBytes` 默认限制为 `32768` 个 UTF-8 字节。POST 请求体须为有效的 JSON 文本，发送时保留原有格式。每个 POST 和状态 GET 请求都带有 `Authorization: Bearer <token>` 和 `User-Agent: deepseek-harness`；POST 还带有 `Content-Type: application/json`、`Idempotency-Key` 和 `X-DSH-Request-Digest`。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-operation-broker)

<a id="private-certificate-authorities"></a>
### 私有证书颁发机构

在HTTPS JSON路由或MCP的`servers`条目中设置`ca: /absolute/path/company-ca.pem`，即可仅为该目标信任私有CA。提供方加载时，控制服务读取并解析PEM文件；文件不可读或无效会导致加载失败。HTTPS路由在发送和状态查询中均使用它。MCP端点在连接中的每个请求中使用它，并保留配置的代理策略。设置`ca`后，这些证书替换该目标的默认信任根。证书链和主机名验证保持启用，不提供跳过验证的选项。

保持文件可由控制服务读取，更改后重启。解析后的绝对路径和内容的SHA-256摘要包含在操作的`routeDigest`及提供方指纹中，由控制服务的见证配置记录。因此更改会使未使用的许可失效，并使该路由的所有者规则停用，直到所有者重新保存规则或路由恢复原状。省略`ca`会保留Node的默认信任根。进程级`NODE_EXTRA_CA_CERTS`也会影响其他连接；这些限定范围的路由不需要使用它。

### 状态端点

业务服务须将 `Idempotency-Key` 和 `X-DSH-Request-Digest` 请求头的值与对应操作一同记录。代理向与 POST 同源的已配置端点发送带身份验证的 GET 请求来查询状态。代理将两个请求头的值分别作为保留查询参数 `operationId` 和 `payloadDigest` 发送。

状态响应使用 HTTP 200，响应体为不超过 4096 字节的 UTF-8 JSON。响应须返回完全匹配的 `operationId` 和 `payloadDigest`，并将 `status` 设为 `pending`、`succeeded` 或 `failed`。终态须包含稳定且不透明的 `receiptId`，由 1 至 128 个 ASCII 字母、数字或 `._~-` 字符组成。业务服务只在自身记录能确认对应操作的结果后签发终态回执。

<a id="mcp-tools"></a>
### MCP 工具

挂载 `@deepseek-ai/dsh-operation-broker/mcp`，可将远程 MCP 服务器的选定工具作为代理操作提供。它注册服务 `operationBrokerMcp`；请将该名称与 `operationBroker` 一同加入授权服务 `operation-control` 条目的 `inject` 列表及其 `broker` 设置。每个服务器需要规范的 HTTPS Streamable HTTP 端点和 Bearer 令牌引用。逐一列出获准的工具并为其指定操作 ID；服务器列出但表中未列的工具无法调用。请求方的 JSON 请求体必须是对象。提供方保存经验证的参数的 `JSON.stringify` 文本，用于存储、审查、哈希、规则匹配和工具调用。

```yaml
- name: '@deepseek-ai/dsh-operation-broker/mcp'
  config:
    servers:
      - url: https://notes.example.com/mcp
        credentialRef: NOTES_MCP_TOKEN
        tools:
          - action: notes-create
            tool: create_note
            description: 'Create one note. The body is {"title": string, "text": string}.'
            returnResponse: true
```

请自行编写 `description`：提供方从不转发服务器自带的工具说明，因此只有运维人员审阅过的文本会到达模型。对每个获准的请求，提供方通过 [MCP 客户端](../../mcp/mcp-client/README.zh.md)建立连接、调用工具并关闭连接。`timeoutMs` 默认为 `60000`，限制凭据查找和连接，并单独限制调用。`maxReadBytes`（默认 `16777216`，最大 `67108864`）限制提供方为一次调用从服务器读取的字节数，计入该连接的每个 HTTP 响应体，包括握手。它保护操作授权进程免受无界数据流的影响；默认值为携带图像或嵌入资源的结果留出空间，提供方会完整读取这些结果，尽管只返回文本。超出时关闭连接：发生在握手期间时，调用报告为未发送；调用发出之后，其结果保持未知。结果会报告服务器是否将其标记为错误。设置 `returnResponse` 后，结果中的文本块在不超过 `maxResponseBytes`（默认 `32768`）UTF-8 字节时返回；更大或回显凭据的文本被省略，调用仍然完成。

-----

<a id="understand-the-implementation"></a>
## 了解实现

独立构建的 MCP 入口与主入口共享 `OperationBroker` 类，因此授权服务能将其识别为代理提供方。

授权服务在预留操作前将父执行 ID 和提案键传给 `OperationBroker.resolve`。在配置相同的情况下，提供方为重复输入生成相同的路由和待发送请求体。HTTPS JSON 提供方原样保留调用方的请求体。它将已保存的路由与当前配置核对，并为每个 POST 和状态 GET 单独解析 Bearer 令牌。部署指纹涵盖路由和限制，生成时无需读取凭据值。`OperationBroker.actions` 列出每个已配置的操作及其用法说明和凭据引用。指纹不包含用法说明。[服务定义和 HTTPS 提供者](src/index.ts)

每个列出的操作还带有 `routeDigest`，即该操作的请求发往何处、返回什么内容的 SHA-256 摘要。授权服务将所有者为该操作设置的无人值守规则绑定到它。对于 HTTPS JSON 路由，它涵盖请求方法、`endpoint`、`reconciliationEndpoint`、`credentialRef`、`returnResponse` 和 `maxBodyBytes`，路由返回响应时还涵盖 `maxResponseBytes`。对于 MCP 工具，它涵盖服务器 `url`、`tool`、`credentialRef`、`returnResponse` 和 `maxBodyBytes`，工具返回结果时还涵盖 `maxResponseBytes`。它不包含 `description` 和 `timeoutMs`，MCP 工具还不包含 `maxReadBytes`：它们既不改变发送的内容，也不改变到达请求方的内容。其他操作的路由不影响它。提供方指纹涵盖摘要涵盖的每个字段。[修改无人值守规则](../operation-control/README.zh.md#edit-unattended-rules)

审批时，提供方可根据已保存的请求提供易读的预览。授权服务也会显示完整的待发送 JSON，并将审批决定绑定到已保存的请求摘要和授权修订版本。

每次调用校验目标服务的证书并发送一次请求。POST 只返回 HTTP 状态码。状态 GET 返回规范化的业务状态，终态还会返回回执 ID。重定向与重试均已禁用。

`@deepseek-ai/dsh-operation-broker/library` 导出 `isBearerToken` 和 `isBrokerReceiptId`，授权服务用它们校验所保存的令牌和回执 ID。

-----

<a id="further-exploration"></a>
## 进一步探索

- 使用操作授权服务审核请求并保留回执。[操作控制](../operation-control/README.zh.md)
- 为操作授权服务配置本地 Bearer 令牌来源。[凭据](../../credentials/credentials/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

通过操作授权服务向调用方提供的结果间接影响模型。

#### KV 缓存影响

代理不添加请求前缀。调用方工具负责保留结果。

## 已知限制与推迟工作

<a id="known-limitations-and-deferred-work"></a>

- POST 响应报告传输状态。业务变更是否完成，以业务服务的记录为准。
- 状态响应缺失、不匹配或不可用时，结果仍无法确认。路由未配置状态端点时，请手动查阅业务服务的记录。
- MCP 无法查询过去的工具调用。未观察到结果的 MCP 请求在有人检查该服务之前保持未确认。
- MCP 提供方支持使用 Bearer 令牌的 Streamable HTTP。不支持需要 OAuth 或作为本地进程运行的服务器。
- 即使操作未设置 `returnResponse`，MCP 结果也必须能容纳在 `maxReadBytes` 内，因为提供方要读取结果才能得知调用结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文（点击展开）</summary>

无。

</details>

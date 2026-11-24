# 从源码运行 Vardock

[English](README.md) | [日本語](README.ja.md) | 中文

设置默认写入`unattendedShell: true`：日常脚本在无网络的工作环境中自动运行，准入和结果证据会记录并由见证服务确认。控制服务在固定规则确定的关键点请求所有者决定，绝不由模型判断：外部业务请求等待批准，除非所有者规则允许；笔记和计划仍需批准。要逐一审查脚本，请在设置时添加`--review-scripts`。现有部署保留其设置。[切换现有配置](../../../../docs/upgrade-guide/v0.2.2-rc.2-vardock/automatic-scripts/guide.zh.md)

Vardock 基于 DeepSeek Harness（DSH）。这些命令准备并管理本地 Web Host、操作控制服务和证据见证服务。每个服务仍通过 DSH Profile 启动。单独运行 `pnpm dsh web` 会启动标准 Harness Web Profile。 以下说明适用于 macOS；systemd 和 Docker 请参见 [Linux](#linux)。

请使用可信的 macOS 账户。三个服务共享您的用户 ID，因此同用户下的其他进程可以读取或修改其状态、访问套接字并控制 VM。见证服务是独立的进程，但不是由他人独立管理的服务。[威胁模型](../../../../SAFETY.zh.md#threat-model)

## 准备源码检出

使用运行 macOS 26 或更高版本的 Apple 芯片 Mac、原生 arm64 终端、Node.js 24.9 或更新版本及其开发头文件、Xcode Command Line Tools，以及根清单中 `packageManager` 固定的 pnpm 版本。在不满足这些 macOS 条件的主机上，命令会以 `Use a native Apple silicon terminal and Node.js on macOS 26 or newer.` 停止。安装 Apple 的 `container` CLI 并将其加入 `PATH`。[根清单](../../../../package.json) · [Apple Container 安装](https://github.com/apple/container#initial-install)

在 Windows 及其他不受支持的主机上，`pnpm vardock --help` 会打印用法；setup、start、stop、doctor 和 verify 会以 `Vardock supports macOS and Linux only.` 停止。

<a id="choose-a-model-provider"></a>
### 选择模型 Provider

设置命令必须传入 `--model-provider <route> --model <id>`；缺少任一选项时，它会在做出任何更改之前停止，并列出两类路由。使用 LLM API Provider 时，`<route>` 是已安装的 [pi-ai 适配器](../../../llm/llm-pi-ai/README.zh.md)目录中提供、并接受 API 密钥的 Provider 路由，例如 `openai`、`anthropic`、`deepseek` 或 `xai`。`<id>` 是该 Provider 的模型 ID。控制服务启动时会检查路由和模型；适配器不认识它们时，控制服务会停止，并在其 `stderr.log` 中写入错误。

设置不会询问密钥。它在控制服务 Profile 中将密钥命名为 `<ROUTE>_API_KEY`，例如 `OPENAI_API_KEY`。首次启动后，在插件页的**连接**中输入密钥。控制服务将其保存在 `<home>/authority/.credentials.yaml` 中，之后不再显示。保存密钥之前，模型请求会失败。

使用 Local Codex 时，请传入 `--model-provider codex-local --model default`，其中 `default` 选择该 Codex 账户的默认模型。请安装 Codex CLI，将其加入 `PATH`，并为此 macOS 账户运行 `codex login` 登录；否则设置会以 `Run codex login for this macOS account.` 停止。此时模型请求使用该 Codex 账户及其使用限额。设置命令不会登录、复制凭据或发送模型请求。[本地 Codex](../../llm-codex/README.zh.md#use-this-package)

## 设置并启动

在源码检出根目录运行，并填入你的 Provider 路由和模型 ID：

```sh
pnpm install
pnpm vardock setup --model-provider openai --model "<model-id>"
pnpm vardock start
```

使用 Local Codex 时，请改为运行 `pnpm vardock setup --model-provider codex-local --model default`。

设置会检查主机、固定版本的 pnpm、已安装的依赖、`container` 命令，使用 Local Codex 时还会检查 Codex 登录。随后它运行 `pnpm run build:artifacts`，并在 Apple Container 未运行时以 `container system start --enable-kernel-install` 启动它；首次使用时，这会下载并安装 Apple Container 的默认 Linux 内核。如果镜像 `dsh-execution:local` 不存在，设置会使用[执行 Dockerfile](../../execution-container/Dockerfile) 通过 `container build` 构建它，该过程会按其固定的摘要拉取 `node:24-bookworm-slim` 并从 Debian 软件包仓库安装 `socat`。最后，它将私有 Profile 和 launchd 任务文件写入 `$HOME/.vardock`，并打印 `Prepared Vardock in <home>. Run pnpm vardock start --home '<home>'.`；使用 API Provider 路由时还会追加 `Then save the model API key under Plugins, Connections.`

设置不会启动服务。启动命令依次加载见证服务、控制服务和 Web Host，等待每个服务就绪，打印 `Vardock is ready.`，然后在默认浏览器中打开入口。

Web Host 加载 [Assistant 补丁](../cordis.patch.yml)，它禁用 Web Profile 的 Office 转换（`office-kit`）、Office 技能（`skill-office`）、账号通知轮询（`ui-account-notifications`）、MCP 服务器管理器（`mcp-manager`）、DeepSeek 账号服务（`deepseek-account`）和 Session 遥测导出（`session-telemetry-otel`）。因此 Host 不写入 Office 输出、不为 Office 技能运行 Python、不从设置启动 MCP 服务器、不轮询账号服务器、不导出 Session 遥测，文档预览也不渲染 Office 文件。

请保持源码检出的位置不变：生成的 Profile 引用其中构建的包。设置拒绝覆盖现有部署，不会重置授权、凭据或已保存工作。构建或镜像准备失败时，会在生成 Profile 前停止。

## 管理部署

| 命令 | 效果 |
|---|---|
| `pnpm vardock setup` | 准备全新部署。 |
| `pnpm vardock start` | 启动服务或重新打开运行中的部署，然后打印 `Vardock is ready.` |
| `pnpm vardock stop` | 卸载 Web、控制服务和见证服务，保留数据与共享 Container 服务。打印 `Vardock is stopped.` |
| `pnpm vardock doctor` | 检查前置条件和部署状态，不修改它们。每项检查打印 `OK  <check>` 或 `Fix <check>. <action>`，有检查失败时以状态 1 退出。 |
| `pnpm vardock verify` | 需在 Vardock 运行期间执行。读取每个见证事件，将每个操作事件与控制服务的回执比对，然后打印 `OK  Every compared event matches.`，或针对每处问题打印一行 `Mismatch` 及其类型可能的含义并以状态 1 退出。控制服务在见证服务确认之后、自身提交之前停止时，也会出现 `receipt-missing`。见证服务从未收到的控制服务记录不会被报告。不修改任何内容。 |

添加 `--home /short/path` 可选择其他部署目录。每条命令均应使用同一路径。

设置接受 `--port 3080`，用该端口代替自动分配的端口。启动接受 `--no-open`，使浏览器保持关闭。使用 `pnpm vardock --help` 查看用法。

launchd 任务使用固定标签 `io.github.virtualhatch-inc.vardock.witness`、`.authority` 和 `.web`，因此每个 macOS 桌面会话只能有一个活动部署。如另一目录的部署正在使用这些标签，必须先使用其自己的 `--home` 停止它，再启动本部署。命令不会接管或停止其他部署。只要使用旧标签 `io.deepseek.dsh.assistant-dev.<role>` 准备的部署已加载或位于所选目录中，命令也会拒绝执行，并打印迁移步骤。[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/vardock-launchd-labels/guide.zh.md)

请在已登录的 macOS 桌面会话中运行启动命令。退出登录或重启 Mac 后，再次运行它。已加载任务的进程退出时，launchd 会重新启动它们。停止会卸载任务，但不会删除 Session、操作记录或 VM 工作区卷。

<a id="default-grant"></a>
### 默认授权

设置将以下授权写入控制服务 Profile：工作可以运行 Shell 脚本（`exec: true`），可以导入和导出文件并将其披露给模型和你，可以接收外部操作的响应文本（全部 `data` 权限，包括 `returnResponses`），不能请求任何 Broker 操作（`brokerActions: []`）。该授权是上限：每次委派在其范围内声明工作所需的权限。该授权允许 1,000 次预约（`maxOperations`），在设置七天后到期（`grantExpiresAt`），每个文件最多传输 8 MiB。在入口的**用量设置**中修改预约上限和有效期。在 Vardock 停止期间，按照[连接服务](#connect-a-service)中的方式修改 `operation-control` 条目的 `assistant.permissions`。`unattendedShell` 只能在该条目中设置；没有页面可以修改它。

设置会写入以下限制。在 Vardock 停止期间，在 `<home>/authority/profiles/operation-authority/cordis.patch.yml` 中修改控制服务的值，在下表所列的 `--patch` 文件中修改 Web 的值。

| 设置 | 值 | 位置 | 原因 |
|---|---|---|---|
| `grantExpiresAt` | 设置后 7 天 | `operation-control` 条目 | 除非你续期授权，一个评估周之后不再接纳工作。 |
| `maxOperations` | 1,000 | `operation-control` 条目 | 每次模型请求占用一次预约，因此该值能限制失控循环，同时足够一周的评估使用。 |
| `maxFileBytes` | 8 MiB | `operation-control` 条目 | 与 Assistant 的单文件读取上限相同，使 Host 和控制服务接受相同的文件。 |
| `timeoutMs` | 5 分钟 | `execution-container` 条目 | 单个脚本（包括工作环境启动）最多运行这么久；该包默认的 30 秒不足以完成启动和文件处理。 |
| `gatewayIdleTimeoutMs` | 5 分钟 | `execution-container` 条目 | 与脚本时限相同，使网关不会关闭仍可能在运行的脚本的空闲连接。 |
| `timeoutMs` | 6 分钟 | [`cordis.patch.yml`](../cordis.patch.yml) 的 `operation-control-agent` 条目 | 超过脚本时限，使 Host 收到控制服务的超时结果，而不是先放弃请求。 |
| `maxActive` | 2 | [`cordis.patch.yml`](../cordis.patch.yml) 的 `assistant` 条目 | 每个工作 Session 运行自己的工作环境和模型请求；限制为两个以控制并发资源使用。 |
| `assistant.permissions.data` | 四项均为 `true` | `operation-control` 条目 | [第一项工作](#try-a-first-work-request)无需修改配置即可导入附件并返回报告。 |

要收窄传输和披露，在 `assistant.permissions.data` 中将 `import`、`export`、`discloseToModel` 或 `discloseToUser` 设为 `false`。导入和导出各自需要两项披露权限，移除 `data` 会拒绝所有传输。

## 诊断问题

运行 `pnpm vardock doctor` 并按照报告的下一步操作处理。它检查前置条件和服务监听状态。请在入口界面读取当前有效额度和任务结果。使用 Local Codex 时，模型请求需要 Codex 登录保持有效；使用 API Provider 时，需要已保存的密钥。启动服务不会续期操作授权。

如启动中途失败，命令会指出受影响的服务。使用 `pnpm vardock stop` 卸载属于本部署的任务，解决原因后再次启动。停止服务不会撤销已经完成的外部影响。

私有日志位于 `$HOME/.vardock/{web,authority,witness}/stdout.log` 和 `stderr.log`，或对应的 `--home`。Web 启动 URL 包含所有者访问令牌。在 macOS 上，管理命令不会打印它；请保密保存日志，不要在未移除敏感内容前粘贴到公开 Issue 中。

<a id="try-a-first-work-request"></a>
## 尝试第一项工作

发送提示前，请检查输入框上方的 **Assistant work**，确认授权剩余预约和到期时间。预约由模型请求、Shell、Broker、文件传输、委派和入口响应共同使用。一次包含单个外部操作的委派请求约使用二十次预约。

选择**试用示例**，在空输入框中准备 CSV 和报告请求。检查后发送。对话将模型请求发送给已配置的模型 Provider。脚本自动运行，证据会记录并由见证服务确认。如果设置时使用了`--review-scripts`，请在批准卡中检查脚本并选择**允许一次**。打开任务返回的报告，预览或下载。[Assistant 控制](../README.zh.md#use-this-package)

在 macOS 和 Linux 上，点击麦克风打开首次使用引导，再打开插件页的**语音输入**，选择识别服务和语言，并手动下载和准备本地模型；模型下载需要明确发起准备请求，重试也不例外。

在 macOS 上，工作 Session 在首次文件导入或 Shell 命令时获得 Linux microVM 和私有工作区。客户机仅有回环网络。操作和批准套接字留在 Host。文件通过显式传输进入或离开 VM。已配置的模型 Provider 会收到通过工作结果披露的数据。外部业务操作默认禁用。

在入口的**用量设置**中修改预留总额度和有效期。保存的额度在重启后保留，并优先于配置档的初始值。已有预留仍计入用量，保存不会恢复中断的任务。请先检查任务，再明确继续；对尚未确定的外部操作使用**核查结果**。不要删除数据库来补充额度或清除结果未知的操作。

[六阶段库存练习](../../../../examples/practice/README.zh.md)无需外部服务账户，演示请求审批、见证记录、结果确认，以及读取自动执行而更新仍等待审批的过程。

<a id="connect-a-service"></a>
## 连接服务

对于新部署，在 `--model-provider` 和 `--model` 之外传入可重复的 `--authority-patch /absolute/path/service.yml` 和 `--permit-action <action-id>` 选项。Setup 将补丁合成到生成的控制服务补丁之后，并把列出的 ID 写入 `assistant.permissions.brokerActions`；未传入 `--permit-action` 时，生成的列表保持为空。只修改 HTTPS broker 的补丁需包含完整的 `operation-broker` 配置（包括 `routes`）；模型、到期时间和其他控制服务设置仍由 setup 选项决定。无法读取、格式错误或目标行不存在的补丁会在写入配置前使 setup 失败。控制服务在启动时验证插件配置，并拒绝没有路由提供的操作 ID；start 和 doctor 会指出其私有 `stderr.log` 和控制服务补丁文件。合成后的配置保存了补丁，因此启动时不再需要源文件。补丁的 `config` 替换该行的整个配置。[加载器配置](../../../../docs/cordis-primer.zh.md#loader-configuration)

对于使用私有证书颁发机构的服务，请在其HTTPS JSON路由或MCP服务器条目中设置`ca: /absolute/path/company-ca.pem`。只有该路由或端点信任这些PEM证书；证书及主机名验证保持启用。控制服务必须始终可读取该文件。更改后请重启：文件路径和内容摘要标识路由，因此已更改路由的所有者规则会失效，下次启动将把变更后的配置记录到见证服务。[Broker CA配置](../../operation-broker/README.zh.md#private-certificate-authorities)

要实现“读取自动，发送审查”，请配置两个Broker操作，并将两者加入`assistant.permissions.brokerActions: [read-records, send-message]`。策略不由操作名称决定，而由所有者指定规则。此配置的效果如下：

| 操作 | 控制服务配置 | 所有者看到的内容 |
|---|---|---|
| 读取记录 | `unattendedBrokerActions: [{ action: read-records }]`；读取路由设为`returnResponse: true` | 无批准卡；业务记录中保留请求、结果及见证证据。 |
| 发送消息 | `send-message`没有无人值守规则 | 批准卡显示目标和保存的确切请求；发送等待所有者决定。 |
| 运行脚本 | `unattendedShell: true`、`backend: apple-vm`、`allowedTargets: []` | 无脚本批准卡；保留执行输出和见证回执。 |

Vardock 只通过控制服务 Profile 配置、且授权允许的操作发送外部请求。操作是 HTTPS JSON Broker 的一条路由（设置会挂载该 Broker，但不配置路由），或远程 MCP 服务器的一个工具。[Broker 配置](../../operation-broker/README.zh.md#use-this-package)

1. 运行 `pnpm vardock stop`。
2. 打开 `<home>/authority/profiles/operation-authority/cordis.patch.yml`，其中 `<home>` 是 `$HOME/.vardock` 或你的 `--home`。设置默认写入JSON，应用控制服务补丁时写入YAML；Profile加载器可读取两者。它包含一个层，其 `insert` 列表保存控制服务的插件条目，每个条目都有 `id`。
3. 按下文说明，将操作添加为 HTTPS JSON 路由或 MCP 工具。
4. 在 `operation-control` 条目的 `config` 中，将每个操作 ID 加入 `assistant.permissions.brokerActions`，例如 `"brokerActions": ["example-create"]`。保持 `execution-container` 条目中的 `allowedTargets: []`；存在 CONNECT 目标时，控制服务会拒绝 Broker 请求。
5. 保持文件私有。只有当此文件、同目录的 `package.json` 和 launchd 任务文件都是归你所有、且没有组或其他用户权限的普通文件时，启动命令才会运行。如果编辑器改变了权限，请对该文件运行 `chmod 600`。
6. 运行 `pnpm vardock start`。此次启动时，控制服务让见证服务记录变化后的配置，在见证服务确认之前不接受任何请求；在此期间发给控制服务的每个请求都以 `configuration-evidence-unavailable` 失败，`<home>/authority/stderr.log` 记录每次未获确认的尝试。如果控制服务未就绪，请阅读同一日志中的配置错误。
7. 在插件页的**连接**中输入该操作的令牌。控制服务将其保存在该操作的 `credentialRef` 下，之后不再显示。它只接受 Bearer 令牌文本。
8. 可选：在同一页面为该操作添加无人值守规则。

如要添加 HTTPS JSON 路由，请在 `operation-broker` 条目的 `config.routes` 中添加一项。Broker 会将工作方的 JSON 正文以 `POST` 发送到 `endpoint`，并将已保存的令牌作为 Bearer 令牌：

```json
{
  "action": "example-create",
  "description": "Create one item. The body is {\"title\": string}.",
  "endpoint": "https://api.example.com/v1/items",
  "credentialRef": "EXAMPLE_API_TOKEN"
}
```

`action` 是工作请求时使用的 ID：以小写字母开头，后接最多 63 个小写字母、数字、`.`、`_` 或 `-`。`description` 原样传给模型；请说明操作的作用及其接受的 JSON 正文。`endpoint` 是不含用户信息和片段的规范 HTTPS URL。`credentialRef` 用字母、数字和 `_` 命名令牌，且不能以数字开头。可选的 `returnResponse: true` 会将响应文本返回给工作方，因此也会交给模型；可选的 `reconciliationEndpoint` 启用只读结果查询。若某个 API 要求 `Authorization`、`Content-Type` 和代理的 `User-Agent` 之外的请求头，则无法通过 HTTPS 路由访问；如果它提供 MCP 服务器，请改用该服务器。[路由字段](../../operation-broker/README.zh.md#example-route)

如要调用远程 MCP 服务器的工具，请在 `insert` 列表中添加一个条目：

```json
{
  "id": "operation-broker-mcp",
  "name": "@deepseek-ai/dsh-operation-broker/mcp",
  "config": {
    "servers": [
      {
        "url": "https://mcp.example.com/mcp",
        "credentialRef": "EXAMPLE_MCP_TOKEN",
        "tools": [
          {
            "action": "example-search",
            "tool": "search",
            "description": "Search items. The body is {\"query\": string}.",
            "returnResponse": true
          }
        ]
      }
    ]
  }
}
```

然后将 `operationBrokerMcp` 加入 `operation-control` 条目的两个列表：其 `inject`（使控制服务等待该 Provider）变为 `["operationBroker", "operationBrokerMcp"]`，其 `config.broker` 也变为同一列表。`tool` 是服务器列出的工具名称；表中未列出的工具无法调用。服务器必须支持 Streamable HTTP，并接受 `Authorization` 中的 Bearer 令牌；不支持需要 OAuth 或以本地进程运行的服务器。例如，GitHub 的文档说明其位于 `https://api.githubcopilot.com/mcp/` 的远程 MCP 服务器接受个人访问令牌作为 Bearer 令牌；本项目尚未验证这一点。[MCP 工具](../../operation-broker/README.zh.md#mcp-tools)

修改 Profile 会改变授权修订版本。尚未消费的批准和许可不再有效，之前委派的工作保留其原有权限，因此请委派新工作来使用新操作。之后修改任何路由或 MCP 工具，也会使所有者已保存的无人值守规则失效。[无人值守规则](../../../../SAFETY.zh.md#approval-recovery-and-completion)

## 运行集成测试

如需运行使用 Codex、Apple VM 和测试自有回环 HTTPS 端点的可选测试，请按 Web 测试设置安装 Chromium。在设置准备好构建和执行镜像后，从源码检出根目录运行此命令。[Web 测试设置](../../../../apps/web/tests/README.zh.md)

```sh
DSH_ASSISTANT_REAL_E2E=1 DSH_ASSISTANT_SCREENSHOT_DIR="$PWD/.artifacts/assistant-real" \
  pnpm run test:web:built apps/web/tests/assistant-real.e2e.ts
```

测试使用临时 Profile 和您的 Codex 账户，覆盖批准、响应丢失后的只读结果查询以及产物下载。它将截图、下载文件和回执摘要保存到指定目录。

## 移除部署

运行 `pnpm vardock stop`，然后删除部署目录 `$HOME/.vardock` 或你的 `--home`。该目录包含 Profile、launchd 任务文件、日志、Session、已保存的密钥和令牌，以及控制服务和见证服务的数据库；删除它会移除所有记录，且无法撤销。

Apple Container 为每个工作 Session 保留一个名为 `dsh-vm-<12 hexadecimal characters>-<32 hexadecimal characters>` 的 VM 及其工作区卷，并保留本机所有部署共享的镜像 `dsh-execution:local`。使用 `container list --all`、`container volume list` 和 `container image list` 列出它们。使用 `container delete`、`container volume delete` 和 `container image delete` 删除它们。

<a id="separate-service-accounts"></a>
## 独立服务账户

管理命令面向 macOS 或 Linux 上的同账户部署。对于独立管理的部署，请为 Web Host、控制服务和见证服务配置不同账户、私有主目录和操作员拥有的产物。为控制服务账户提供其自己的模型凭据，并让它独占访问执行后端。[控制服务和套接字所有权](../../operation-control/README.zh.md#use-this-package) · [证据见证服务](../../operation-evidence/README.zh.md#use-this-package)

<a id="linux"></a>
## Linux

使用可信的 Linux 账户，并准备 Node.js 24.9 或更新版本及其开发头文件、检出所固定的 pnpm、`lsof`、systemd 用户服务（`systemctl`、`systemd-analyze`、`systemd-run`、`loginctl`）以及 Docker。三个服务共享你的用户 ID。使用 rootful Docker 时，`docker` 组成员拥有相当于 root 的主机控制权；同用户下的见证进程不构成独立证据存储。[Docker 访问](https://docs.docker.com/engine/install/linux-postinstall/)

启用 lingering，使服务在退出登录后继续运行并在开机后重启。未启用时，设置和 doctor 会失败，并打印供所有者运行的确切命令 `sudo loginctl enable-linger <uid>`；它们从不运行 sudo。将账户加入 Docker 组后，重启其用户服务管理器并重新连接。诊断会打印 `sudo systemctl restart user@<uid>.service`；这会停止该账户的所有用户服务。仅让新 Shell 获得组成员身份不会更新管理器。

选择本地 `unix://` Docker 上下文。设置和 doctor 要求 cgroup v2、内存限制、PID 限制、CPU CFS 配额，以及 Docker 已注册的所选运行时。它们通过 `systemd-run --user` 临时运行 `docker info`，检查管理器的访问能力。

Linux 必须传入 `--runtime`，没有默认值；macOS 拒绝此选项。Doctor 打印运行时及其限制：

| 运行时 | 隔离和限制 |
|---|---|
| `runc` | 共享宿主内核的普通容器，不是 VM 隔离边界。 |
| `runsc` | 使用 gVisor 用户态内核。PID 限制计算沙箱的 Host 任务，不限制来宾进程数。 |
| `kata` (`io.containerd.kata.v2`) | 在类型上提供 VM 隔离边界并需要 KVM；本项目尚未验证。 |

请先安装并注册运行时。Kata 需要 rootful Docker 和可用的 KVM。Doctor 检查运行时注册、守护进程能力和服务监听，不启动工作容器或验证隔离；即使已注册的运行时无法启动，它也可能通过。真实生命周期和执行检查覆盖一台使用 Docker 29.9、runc 和 runsc 的 arm64 Ubuntu VM。Kata、x86_64、其他发行版和 rootless Docker 仍未经验证。请在目标主机验证启动、重启及工作执行。

一次真实的 Linux 运行曾报告 `EXEC_STOP_UNKNOWN`；此后未能复现，原因仍不明。出现此错误时，工作会显示结果未知。请确认容器已停止，检查工作的工作区结果及**业务记录**中的外部操作结果，然后再决定是否重试请求。

从检出根目录运行，替换为你的 Provider 和模型，并在每条命令中使用相同的较短私有目录：

```sh
pnpm install
pnpm vardock setup --home /short/vardock --model-provider openai --model "<model-id>" --runtime runsc --port 3080
pnpm vardock start --home /short/vardock
pnpm vardock doctor --home /short/vardock
```

使用 Local Codex 时，以部署账户运行 `codex login` 登录，并替换为 `--model-provider codex-local --model default`。启动后通过**连接**保存 API 密钥。设置会构建检出，并通过 `docker build -t dsh-execution:local packages/experimental/execution-container` 构建缺失的 `dsh-execution:local` 镜像。控制服务的 Docker 条目包含套接字、运行时、网关套接字、镜像以及相同的五分钟执行和网关超时。[模型 Provider](#choose-a-model-provider) · [默认授权](#default-grant)

设置在主目录中以 0600 权限写入单元 `io.github.virtualhatch-inc.vardock.{witness,authority,web}.service`，并以 0600 权限预先创建私有日志。启动使用 `systemctl --user enable --now <absolute-unit-path>`，按见证服务、控制服务、Web 的顺序启用，每次等待服务就绪。单元在进程退出 30 秒后重启，并随 `default.target` 启动；主机重启后，仅靠 `After=` 不会等待应用就绪。固定名称使每个用户只能运行一个部署；命令拒绝从其他目录加载的单元。

Linux 启动会打印带身份验证信息的 Web URL，不打开浏览器；仍接受 `--no-open`。URL 和日志包含所有者访问令牌：请保密。远程访问时，转发相同的本地端口，例如 `ssh -N -L 3080:127.0.0.1:3080 user@host`，再在本地打开打印的 `http://127.0.0.1:3080/?token=…` URL。请保持主机拼写和端口相同：浏览器 Cookie 与它们绑定。

移除部署时，运行 `pnpm vardock stop --home /short/vardock`，依次禁用并停止 Web、控制服务和见证服务。Stop 等待 systemd 在各单元的 `TimeoutStopSec` 限制下完成关闭。仅在不再需要已保存工作、凭据、授权和证据记录时，才删除该主目录。Docker 工作容器、工作区卷和共享镜像会保留。使用 `docker ps --all`、`docker volume ls` 和 `docker image ls` 检查它们，只移除已确认可丢弃的资源。

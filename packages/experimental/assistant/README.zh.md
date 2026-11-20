---
description: "从一个 Web 会话委派后台工作、查看工作会话并取回已保存的报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant

[English](README.md) | 中文

## 概述

Vardock默认在无网络的VM中自动运行日常脚本，并记录每项操作及其见证证据。控制服务在固定规则确定的关键点请求所有者决定，绝不由模型判断：外部业务请求等待批准，除非所有者规则允许；笔记和计划仍需批准。 在同一个 Assistant 会话中委派工作并接收报告。每项请求在单独的会话中运行，可以打开该会话检查过程。宿主重启后，Assistant 会保留排队的请求和已保存的报告。继续宿主停止时正在运行的工作之前，请先检查对应会话。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

若要使用 Apple Container 以及 LLM API Provider 或 Local Codex 试用 Assistant，请使用 [macOS 开发配置](vardock/README.zh.md)；Linux 使用 [systemd 和 Docker 配置](vardock/README.zh.md#linux)。

配置[执行授权服务](../operation-control/README.zh.md)及其由独立账户管理的[证据服务](../operation-evidence/README.zh.md)，然后使用 [Assistant 补丁](cordis.patch.yml) 启动 Web 配置档。将 `DSH_OPERATION_SOCKET` 设为授权给 Agent 宿主账户的执行服务 socket，并将 `DSH_APPROVAL_SOCKET` 设为独立的审批决定 socket。授权服务的 `approvalSocketPath` 必须与后者一致。仅对应的服务账户可访问执行后端和证据存储。补丁在每一步刷新时钟上下文，并保留 standard 预设的上下文压缩，并由 Assistant 组合提供工具，避免预设工具覆盖它们。补丁卸载其他 Web 预设，这些预设会挂载主机 Shell 和文件工具；Assistant 角色守卫仍会拒绝各 Session 角色之外的工具。

```sh
pnpm run build:artifacts
DSH_OPERATION_SOCKET=/run/vardock-control/agent.sock DSH_APPROVAL_SOCKET=/run/vardock-control/approval.sock pnpm dsh web --patch ./packages/experimental/assistant/cordis.patch.yml --host 127.0.0.1 --port 0 --no-open
```

该补丁禁用以下继承的控件：

- 子 Agent、网页搜索和 Shell 设置、权限与模型选择器、技能、引用、计划、目标、子 Agent、团队、后台作业和自定义菜单不控制 Assistant 工作，或提供其角色无法使用的工作流。
- 宿主终端、内嵌浏览器、工作区文件、宿主目录选择器、文档预览、本机应用启动、文件变更卡片、通用交付物和工作流卡片不代表经授权服务控制的工作。
- 模型、账号和会话日志上传设置针对继承的宿主服务，而非 Vardock 的连接。
- Office 转换、Office 技能和账号通知轮询会执行无关的宿主处理。
- MCP 服务器管理器、DeepSeek 账号服务和 Session 遥测导出会在授权服务之外启动程序或访问服务；外部服务改为通过授权服务的 Broker 连接。

连接和业务记录、Agent 循环设置、自动化任务、聊天与轨迹、文件接收、审批卡片、通用偏好和只读插件清单仍可使用。预设 UI 保持加载以提供清单使用的本地化预设名称，但隐藏首页选择器和页头标签；权限与预设运行时服务以及 Bash 沙箱也保持启用。Assistant 成果文件卡片、内嵌预览和下载使用自己的渲染器和身份验证路由。入口隐藏工作区选择器和预览标记，将首页标题设为 Vardock，并使用简洁的本地化消息占位文本。Vardock 部署的插件集合由其配置档固定；操作者通过编辑配置档补丁并重启来更改，涉及授权服务的配置变更由见证服务记录。

覆盖层包含本地语音输入；麦克风打开设置引导，语音输入页面提供识别偏好和手动模型准备。语音输入在授权服务之外运行：浏览器发起的准备请求会让宿主从 `https://huggingface.co` 下载固定修订版本并经 SHA-256 校验的 [SenseVoice](../speech-to-text-sensevoice/README.zh.md) 模型和 VAD 文件，转写则在宿主启动的本地 Node 工作进程中运行。

打开 `dsh web` 打印的 URL，默认进入助手会话。侧栏顶部的**助手**按钮和新建会话快捷键均可返回此会话。若打开失败，可选择**助手**重试。配置模型后，可请助手委派一项上下文完整的任务。只有已认证的宿主所有者可以打开入口、提交输入或编辑自己已排队的消息。此插件挂载期间，其他会话为只读。

尚未委派工作且输入框为空时，选择**试用示例**，准备 CSV 附件和生成 Markdown 报告的请求。检查草稿后正常发送。示例使用已配置的模型、普通委派及现有执行审批，无需外部业务服务。已有草稿不会被替换。

展开消息输入框上方的**助手任务**，可查看已保存的任务及其停止或失败原因。工作会话可用时，点击**查看会话**即可打开。点击**停止任务**可取消排队中或运行中的请求。取消后，已可能发生的影响仍会显示。面板显示授权服务的剩余额度和到期时间，并在连接中断时提示状态可能已过时。点击**刷新状态**可读取最新记录。

执行者报告和已确认的外部结果分别显示。如果工作的外部请求结果尚未确认，执行者报告完成也不会结束该工作：该行显示**任务结果未知**。发送给入口的提示会说明：脚本已运行，但外部结果未知，请求可能已经生效，也可能没有；未经所有者指示不得重发。对于结果未明的外部操作，点击**核查结果**可发起只读查询，无人值守规则发送的操作也可以。授权服务验证查询证据后才会记录已确认的结果。所有外部结果均已确认且没有其他操作结果未明时，该行显示已确认的外部成功或失败，并清除结果未明的警告；保存的执行者报告保持不变。如果执行者报告失败而授权服务没有报告其他问题，也会使用该显示方式；执行者的失败状态仍与报告一同显示。该行显示执行者自己的文本，不显示协调器面向模型的英文提示。授权到期后，仍可读取已保存的记录，但无法发起新查询。

打开**用量设置**可读取并修改预留总额度和有效期。已消耗的预留仍计入用量，工具、数据和委派权限不会扩大。保存更改后的额度会使待批准请求和未使用的许可失效，保留运行中的操作与结果，不会重启任务。无法确认更新时，请读取当前设置后再保存。这些控件需要交接提供方通过 `DSH_APPROVAL_SOCKET` 连接所有者接口。

在插件页打开**连接**，可查看授权服务允许的外部操作、各操作是否已有令牌、哪些请求无需批准即发送，以及响应是否可能到达模型。授权服务配置档为模型路由指定了密钥时，同一页面也保存该 API 密钥。输入令牌即可将其保存到授权服务；该字段从不显示已保存的值。可为每个操作添加或删除无需批准即发送其请求的规则：规则可要求请求正文的顶层字段等于指定值，此时必须列出请求还可以包含哪些其他字段。填写条件但将其他字段留空表示不允许其他字段；所列字段可以取任意值。见证服务记录后，授权服务才应用规则修改。从第一次修改起，所有者的规则取代配置档中的规则。所有者保存某个操作的规则后该操作发生变化时，该操作会显示提示：其已保存的规则仍被保存但不生效，它的每个请求都等待批准，直到所有者再次为它保存规则（从空列表开始），或该操作恢复到所有者保存时的完全相同状态。其他操作的规则不受影响。添加操作需要编辑授权服务的配置档；参见[连接服务](vardock/README.zh.md#connect-a-service)。[连接凭据](../operation-control/README.zh.md)

在插件页打开**业务记录**，可按从新到旧的顺序查看授权服务记录的每个外部请求。每一项显示操作、决定（已批准、已拒绝、按规则无需批准即发送或等待批准）、结果、见证服务是否持有回执、查询或所有者判定的完成情况，以及**请求**下的原文。**读取更早的记录**读取下一页，**读取当前记录**回到最新记录。对于发送后结果尚未确认的操作，**我已核实：已发生**和**我已核实：未发生**会记录您在外部的核查。判定只有经见证确认后才生效；该行随后标明所有者，派生工作状态与查询确认后一样更新。未经确认的判定不会解除阻止，并会显示重新读取记录及检查服务的提示。[业务记录](../operation-control/README.zh.md#read-business-records)

审批标题会缩短较长的任务标识符；**完整详情**在审计原因中显示其完整值。

在“试用示例”中，订单总数是 CSV 的 `orders` 列之和，收入总额是 `revenue_usd` 列之和。任务行在执行者报告旁列出返回的文件。**预览**读取不超过 64 KiB 的 `.txt`、`.md`、`.markdown` 和 `.csv` 文件的 UTF-8 文本，不执行标记内容。**下载**获取完整的经见证文件。对于可查看的中断任务或待补充信息的请求，**继续任务**会为该任务 ID 准备可编辑的后续草稿。发送前请检查草稿及未确认结果；准备草稿不会重启任务。

Assistant 为每个新工作请求声明权限：命令执行（所有脚本都需要，包括读取文件、计算总数和编写报告）、精确的外部操作，以及文件和响应权限，且不超过授权服务配置的权限。授权服务拒绝未声明权限的新工作。未声明权限的继续工作保留前序授权，并随之后降低的配置权限收窄；它可以请求更窄的权限，但不能扩大。具有命令执行权限的工作 Agent 请求 `exec`；默认macOS设置会自动运行并记录准入和结果证据。使用`--review-scripts`时，入口显示审批卡片，空闲时也可接收；**允许一次**仅批准该次操作保存的脚本。宿主重启后，请检查中断的工作再显式继续。

运行中的脚本请求工作授权范围内的 HTTPS 操作且没有所有者规则放行时，入口会显示审批卡片，列出请求方法、目标地址和原样 JSON 请求体。**允许一次**仅批准该次请求。[HTTPS 业务请求](../operation-control/README.zh.md#enable-https-business-requests)

所有者可在消息中附加文件，请助手在新工作中使用。 该所有者请求触发入口轮次时，新工作必须声明 `inputs`：选择附件，或为不需要文件的工作传入 `[]`。省略时会在创建授权或工作会话前被拒绝；错误会列出每个附件及其选择值。不带附件的所有者请求仍可省略，继续工作则继承原有输入。选中的输入仍需要导入权限和两项披露权限。入口将图片作为普通文件上传，为工作会话保留原始字节。拖放提示显示普通图片的接收限制，工作传输则应用已配置的文件大小限制。授权服务允许传输和披露时，工作会话可在其工作区的 `input/` 下找到选定的输入。点击结果通知中的下载链接，可获取经见证的产物。继续工作会保留先前的工作区和输入范围。若要选择不同的文件，请发起新工作。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mainSessionId` | `assistant-main` | Assistant 使用的固定会话 ID。Harness 主目录初始化后请保持此值固定。 |
| `maxActive` | `2` | 同时运行的工作请求上限。 |
| `maxFileBytes` | `8388608` | 宿主读取每个工作输入的字节上限。授权服务另行应用自身的传输限制。 |
| `workStatusRefreshMs` | `2500` | 入口可见时两次状态读取之间的毫秒数。取值为 500 至 60000。 |
| `maxNotesBytes` | `4096` | 单次 `write_notes` 调用保存的笔记文本的最大 UTF-8 字节数；每次入口请求都会重复已保存的笔记。默认值可用约 1,000 个 token 容纳数十条简短偏好。取值为 1 至 65536。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-assistant)列出自定义组合所需的字段和服务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节，点击展开</summary>

[协调器](src/index.ts)将主会话和工作会话加入其所记录的起始目录对应的工作区。它以调用方提供的请求键保存受理记录。使用相同的键、指令和请求权限重试会返回同一请求。显式继续工作时使用新的键，并复用先前的工作会话。复用键只会读取参数完全相同的原请求，不会再次执行。

[仲介策略](src/mediation.ts)接入现有的 Remote 访问服务。只有所有者可查看入口和获准导入输入或导出产物的工作会话。入口的步骤取出访客已排队的提示词或重试请求时，协调器会阻止该步骤。作用域工具限制控制模型 schema，独立的工具 guard 拒绝未经授权的执行，包括 Agent 本地工具覆盖。工作会话只接纳已记录的委派请求。

[存储域](src/state.ts)保存队列和报告的结果。协调器根据授权核对每个附件在消息中的确切位置，等待导入获得见证，再记录运行状态并唤醒工作会话。工作会话进入空闲状态后，主会话收件箱接收结果，协调器可以通过回执投影识别宿主停止前已入队的结果。授权服务放行全部请求的导出后，产物元数据才进入结果。所有者下载时按已保存的工作和索引读取授权服务验证过的快照。

必需的 `handoffControl` 服务仲介委派和入口响应发布。Unix 提供方在请求入队前验证原样工作指令和已确定授权的放行回执。协调器保存该授权，并在分派前再次验证。未记录授权的旧工作仍可查看。要替代这类工作，请使用新键发起新的工作请求。入口会缓冲每次模型流，包括可见推理和工具参数，直至发布获得见证。失败时不会公开候选片段。响应内容在 JSON 传输编码前限制为 128 KiB。普通 LLM waterfall 和 Session 机制负责响应记录与显示。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [执行授权服务](../operation-control/README.zh.md) — 操作授权、执行观察和证据回执。
- [pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)——让助手和工作会话访问 LLM API Provider。
- [本地 Codex](../llm-codex/README.zh.md)——改为使用现有的 Codex CLI 登录。
- [实验包](../README.zh.md)——支持范围和组合策略。
- [Web 配置档组合包](../../bundle/web-app/README.zh.md)——此补丁使用的提供方。
- [会话控制器](../../api/session-controller/README.zh.md)——常规会话创建和历史。

-----

<a id="model-experience"></a>
## 模型体验

### 委派工具 schema

#### 模型看到的内容

主会话接收 `list_work_inputs`、`delegate_work`、`list_work` 和 `stop_work`。`list_work_inputs` 提供所有者最近一次附加文件的位置，供 `delegate_work` 选择输入。`delegate_work` 为新工作要求 `permissions`；其中 `data.returnResponses` 决定工作会话的命令能否收到外部操作的响应文本。工作记录包含授权服务提供的 `principalId` 和授予的 `permissions`。[执行授权服务](../operation-control/README.zh.md)提供相应工具时，主会话也接收 `list_business_actions` 和 `inspect_business_operations`。`list_business_actions` 返回获准的外部操作及其用法说明，用于编写工作会话的指令。使用工作会话 id 查询外部操作证据。此组合还为主会话挂载[定时任务工具](../../schedule/tool-schedule/README.zh.md)：`schedule_create`、`schedule_list`、`schedule_view` 和 `schedule_edit`。Assistant 拒绝 `target` 不是 `this_session` 的任务，因此每次触发都作为入口的一个轮次到达，而入口只能委派。在 `callerTargetOnly` 下，入口只能列出、查看和改变投递到自身的任务。每次 `schedule_create` 和 `schedule_edit` 都等待所有者在批准卡片上决定；卡片显示标题、完整提示和重复规则，编辑时显示请求的改动和当前任务。卡片将每个标题、提示和规则显示为一个带引号的 JSON 字符串，其中每个控制字符、格式字符、行分隔符、段落分隔符和变体选择符都显示为 `\n` 或 `\u200b` 等转义序列，因此不可见字符也会显示出来；存储的值不变。编辑或删除必须携带与 `schedule_view` 返回的 `updatedAt` 相同的 `expectedUpdatedAt`，卡片显示的就是该版本；卡片之后被修改的任务返回 `schedule_conflict`，并保持其已存储的状态。拒绝或没有能回答的所有者时，返回工具错误且不做任何改变。主会话还接收 `write_notes`，见“入口笔记”。正在执行工作请求的会话接收 `report_work`，获得命令执行权限时也接收 `exec`。工作会话通过 `report_work(needs_input)` 返回问题，由 Assistant 询问用户并显式委派继续请求。此组合中的其他会话不能启动模型轮次。委派工具见[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-assistant)。

##### 助手入口指令

```markdown
You are the Assistant entrance. Delegate independent work with delegate_work, acknowledge its acceptance, and end your turn. Reports arrive in a new turn automatically. Scripts run automatically by default; a deployment may require script approval. External requests wait for owner approval unless a configured rule admits them. Notes and schedule changes always require owner approval. When work fails, needs input, or has an unknown outcome, explain it and await the owner’s direction; do not automatically delegate another attempt or replace the requested deliverable with unverified text. Inspect uncertain external operations before attempting another submission. A scheduled task delivers its prompt to you in a later turn; delegate the work it asks for then.
```

#### Token 影响

每次符合条件的请求都包含其角色对应的工具定义。入口还会接收上述固定指令。工具调用和结果进入该会话的历史。

#### KV Cache 影响

工具调用和结果追加到历史。工具的适用条件变化后，下次请求可用的工具定义也会变化。

### 工作请求和报告

#### 模型看到的内容

工作会话接收任务提示词、授予的权限、`/workspace/input/` 下的导入文件绝对路径和下方的报告指令。 列出输入时，还会告知工作会话：请求中位于 `/workspace` 之外的路径在工作环境中不存在，所列输入才是可用文件。其可选宿主运行时提示被隐藏；必需的目录元数据明确标为宿主元数据，而非 exec 工作区。继续工作时会标明新工作请求及其前置请求；早期操作仍属于历史，结果未确认的操作仍不得重复。导入过文件的工作只有在本次工作中观察到非错误的 exec 结果后才能报告完成；否则 Assistant 会记录失败并隐藏所报结果，缺少 exec 权限时会明确指出。这一观察不验证文件是否被读取，也不验证所报数值是否准确。主会话通过通知接收 `work_id`、`session_id`、`status` 和 `result`，以及已放行产物的文件名、大小和摘要。对于其会话导入过所有者文件的工作，Assistant 先询问授权服务当前权限是否仍允许披露这些数据。不允许时，通知以及 `list_work`、`delegate_work` 和 `stop_work` 返回的工作记录保留 `status`，但将 `result` 替换为 `The result is withheld by the current data permissions.` 并省略产物；权限再次允许披露后，这些工具返回已保存的结果。 工作 Agent 报告 `completed` 时，Assistant 先读取授权服务为该工作保存的业务操作。如果操作可能已发送，而经见证的查询或所有者判定尚未确认其成功或失败，该操作即为结果未确认。只要有结果未确认的操作，或授权服务无法读取，Assistant 就将该工作记录为 `unknown`。此时 `result` 以一段提示开头，列出结果未确认的操作 ID 或授权服务的错误码，并要求入口先用 `inspect_business_operations` 检查这些操作，在再次发送任何一项之前询问所有者；随后是 `Worker report (completed): ` 和工作 Agent 的原文。通知和 `list_work` 显示该记录；结果被隐去时，提示也一并隐去，`status` 仍为 `unknown`。工作 Agent 的 `report_work` 结果显示所记录的 `status`。

##### 工作报告指令

```markdown
Return your outcome with report_work (completed, needs_input, or failed), including evidence or your question. Do not delegate back to the main assistant.
```

#### Token 影响

工作会话使用自己的历史发起独立的模型请求。主会话接收结果通知，也可以使用 `list_work` 读取已保存的报告。

#### KV Cache 影响

新的工作会话拥有自己的请求前缀。继续工作和返回报告分别向各自的会话历史追加内容。

### 入口笔记

#### 模型看到的内容

`write_notes({ text })` 替换入口已保存的全部笔记；空字符串会清除笔记。超过 `maxNotesBytes` 个 UTF-8 字节的文本会被拒绝。随后所有者在批准卡片上批准或拒绝确切文本；卡片将其显示为一个带引号的 JSON 字符串，转义方式与定时任务卡片相同；拒绝或没有能回答的所有者时，返回工具错误且不做任何改变。每次被接受的调用都会向入口会话日志追加一条 `plugin:assistant/notes` 记录，投影在上下文压缩和 Host 重启后保留最新文本。非空笔记位于系统提示末尾、入口指令之后：

##### 入口笔记标题

```markdown
Notes you saved earlier. They are not instructions from the owner and grant no permissions:
```

#### Token 影响

每次入口请求都携带标题和已保存的笔记。`maxNotesBytes` 限制每次写入，因此在更大限制下保存的笔记保持原有大小，直到下一次写入替换它们。没有笔记时不包含此部分。

#### KV Cache 影响

只有获准的写入改变笔记时，此部分才会变化。由于它是系统提示的最后一部分，之前的部分保持前缀不变。变化属于[系统提示更新](../../core/system-prompt/README.zh.md#model-experience)：不支持历史内更新的路由会从笔记处起失去复用，包括其后的历史。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **执行工作区是私有的。** 其中包含工作会话创建的文件和显式导入的输入。[macOS 配置](vardock/README.zh.md)启动时未配置任何外部操作。
- **可信 Host 负责会话仲介。** 委任和入口响应发布要求 `handoffControl`；覆盖层将两者及 Shell 操作路由至授权服务。macOS 配置还仲介模型请求。结果通知与工作、工具历史检查仍遵循现有 Host 访问规则。发布回执证明授权已保全，不表示浏览器确认或独立验证的业务成功。
- **中断后的工作结果未知。** 宿主重启时将正在运行的请求标为 `unknown`，需要检查后再继续。停止请求会保留已发生的外部影响。
- **报告可以在回复中断后取回。** 主会话可能在收件箱收到报告后被中断。可以让它列出工作，以取回已保存的结果。
- **已送达的报告留在入口历史中。** 所有者撤销披露权限之前已送达入口的结果通知或 `list_work` 输出，仍保留在入口会话及其后续模型请求中；隐去只适用于权限变更后展示的报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者查阅的工作背景，点击展开</summary>

无。

</details>

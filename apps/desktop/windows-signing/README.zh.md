---
description: "配置 Windows 签名凭据、EV Token 与签名缓存。访问 Token 前，先阅读信任前提。硬件失败需要操作者检查；打包成功不代表安装或生产发布已通过验收。"
---

# Windows 签名

[English](README.md) | 中文

## 概述

配置 Windows 签名凭据、EV Token 与签名缓存。访问 Token 前，先阅读信任前提。硬件失败需要操作者检查；打包成功不代表安装或生产发布已通过验收。

## 目录

- [信任前提与隔离缺陷](#trust-and-isolation)
- [机器配置](#machine-setup)
- [签名配置](#signing-configuration)
- [签名与时间戳处理](#windows-ev-signing)
- [失败记录与人工恢复](#failure-and-recovery)
- [签名缓存与并发阶段](#signature-cache)
- [验证范围](#verification)

<a id="trust-and-isolation"></a>

## 信任前提与隔离缺陷

签名以打包机器上的代码和操作人员可信为前提。未签名模式跳过签名文件加载，但无法阻止同一 Windows 账户下的其他代码读取这些文件或访问 Token。SafeNet Single Logon 可能复用认证状态。直接调用设备可以绕过签名脚本并耗尽 PIN 重试次数；持久失败 interlock 只保护经过这些脚本的调用。跨账户 Token 隔离和剩余重试次数尚未验证。在该机器上运行不可信代码前，或出现可疑活动后，重新评估账户和设备隔离。

<a id="machine-setup"></a>

## 机器配置

运行 `pwsh -NoProfile -File apps/desktop/scripts/setup-windows-packaging.ps1 -Root <absolute-machine-root>` 创建私有 `packaging/{presets,secrets,certificates}` 和 `cache/windows-signatures` 目录并复制模板，不覆盖现有文件。添加 `-CheckOnly` 只检查不写入。在机器上填写 [preset 模板](../config/windows-packaging/test.env.example)和[签名模板](../config/windows-packaging/windows-signing.env.example)；打包 `--check` 检查工具链。该配置脚本不创建 token、不改系统安全设置、不清除签名失败记录。修改 preset 缓存路径前，使用下文签名缓存维护命令迁移已有条目。

<a id="signing-configuration"></a>

## 签名配置

通过[机器 preset 配置](../packaging/README.zh.md#configuration-and-local-builds)选择公开设置与签名文件；不选择 preset 时使用目标 dotenv 文件。

在 `.env.windows` 中填写 `DSH_DESKTOP_WINDOWS_CER_FILE`（公开 EV 叶证书）、`DSH_DESKTOP_WINDOWS_SIGNTOOL`（SafeNet 兼容的 SignTool）、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`（匹配的私钥容器）和 `DSH_DESKTOP_WINDOWS_TOKEN_PIN`（Token Password）。私钥仍保留在 USB Token；不要把证书或本地凭据文件提交到 Git。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向签名预检、独立的第一方运行时签名阶段与 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。本地 `.env.windows` 或机器管理的 `secrets/windows-signing.env` 明文保存 PIN，应限制文件访问权限。不要提交或分享文件内容，也不要把凭据写入日志。配置检查不会消耗 Token 的 PIN 尝试次数；签名仍在首次失败后停止整批任务。

签名 Windows 配置从同一份公开证书的 `CN`、`O` 和 `C` 属性生成 updater 的 `publisherName`。每个属性都必须存在、非空且只有一个值。这些身份属性允许证书续期，无需固定叶证书指纹。已安装应用的 `app-update.yml` 保存预期发布者，下载的清单不能选择该身份。未签名测试构建省略 updater 配置。真实文件验证及其限制见[签名验收记录](../tests/README.zh.md)。

<a id="windows-ev-signing"></a>

## 签名与时间戳处理

启动签名构建前，先按[版本与打包说明](../packaging/README.zh.md#release-versions)确认输入。配置检查不代表 Token 认证成功。

Windows 签名构建在编译或准备依赖前执行受监督的签名预检。静态配置、证书有效期、审计存储、编译器可用性及遗留签名锁的检查不访问 Token。本地 .NET Framework C# 编译器生成一个专用小探针，由正式签名器仅签名一次，随后必须验出配置的证书和时间戳才能继续构建。探针绝不执行。预检的整体 60 秒期限包含时间戳尝试；超时、硬件签名报错或验签失败都会停止本轮流程，不再次调用硬件。成功只证明当前签名路径可用，不证明 PIN 已独立认证：SafeNet 可能复用登录状态。不要为了验证 PIN 而注销或重复认证。`--check`、仅准备和 `--unsigned` 模式不执行此硬件预检；未签名产物仍不能发布上传。自动回归测试使用假签名器，真实硬件由发布操作人员单独验收。

公开身份查询要求构建账户的 `PATH` 中有 PowerShell 7（`pwsh`）；查询进程不可用或失败时，以身份未知结果停止签名。编译探针前，独立非交互进程使用 `CRYPT_VERIFYCONTEXT | CRYPT_SILENT` 从固定的 eToken CSP 读取公钥。该进程只接收容器名，不接收 PIN 或签名凭据；15 秒期限计入已有预检总期限。两个 RSA 密钥槽必须完整读取（允许槽不存在），且至少一个公钥与配置证书匹配。提供程序或容器访问失败、不支持公开读取、输出损坏、超时或不匹配时，在硬件签名前停止。容器访问错误不能证明设备或容器不存在。中间件可能缓存公开信息，因此匹配不代表设备已认证、PIN 正确或已确认剩余尝试次数。此路径已由模拟 CSP 覆盖，当前 SafeNet 版本仍需操作人员单独验收。任何失败都不会自动重试认证或清除已有保护锁。

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`和 SHA-256 文件摘要，不请求时间戳。随后钩子在隔离副本上完成 DigiCert SHA-256 RFC 3161 时间戳，不传递签名凭据。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

时间戳处理仅对正常退出但返回失败或警告的时间戳命令重试，最多尝试三次，间隔为一秒和两秒。每次均从同一份已验证的主签名开始。启动错误、终止状态不确定或验签失败会立即停止。SignTool 使用短的私有路径；发布时先把已验证字节复制到目标卷，再原子替换。最终必须通过 Windows 信任、证书、时间戳和规范化全文件相等检查。尝试耗尽后停止打包并保留证据，不再次调用硬件。参见[签名完成决策](../../../.agents/notes/implemented/process/2026-09-17-windows-signature-completion.zh.md)。

<a id="failure-and-recovery"></a>

## 失败记录与人工恢复

将 `SignTool Error: No private key is available.` 视为签名失败：立即停止所有签名尝试，由操作者检查签名配置和 Token 状态后再继续。设备具体的 PIN 重试上限和剩余次数尚未验证，不得通过认证尝试探测。出现此错误后不要重试打包或签名探针。签名器串行执行 Token 操作，并在首次失败后拒绝所有排队任务。

Windows 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `.desktop-build/packaging-runs/` 下的唯一目录。每次运行保留 `run.json`、带时间戳的 `events.jsonl`、脱敏后的 `stdout.log` 和 `stderr.log`，以及 `result.json`。签名失败还会写入 `fatal.json` 并通过 stderr 通知父进程；监督程序立即请求终止当前阶段的进程树并等待退出。失败阶段不能启动后续阶段或生成发布完成记录。日志写入失败也会停止运行。终止错误仍按失败处理，需要操作者检查；缺少最终记录表示尚未确认完成。

硬件签名必须属于受监督的打包运行。调用命令解释器前，签名器原子获取 `%USERPROFILE%/.dsh-desktop-signing/attempt.json` 并记录本次尝试。只有签名成功且配置证书的主签名通过验证后才释放该文件；随后完成时间戳，不再访问硬件。失败、中断、已有锁定文件或审计存储不可用都会阻止再次访问硬件，包括同一 Windows 账户下的另一个签名器实例、进程或代码检出目录。没有定时恢复或自动重试。管理员必须检查保留的证据及令牌状态，再明确授权恢复锁定状态；登录令牌或替换 PIN 文件不会清除它。记录区分签名意图、命令解释器 PID 和完成结果，不计量 CSP／令牌内部的认证次数。不记录命令参数、PIN 或凭据环境。其他 Windows 账户及无关签名程序不在此锁定机制的保护范围内。

<a id="signature-cache"></a>

## 签名缓存与并发阶段

运行时签名在当前 Windows 账户的各 worktree 间共享完整的已签名文件。`.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR` 指定固定本地磁盘上的绝对目录；默认值为 `%USERPROFILE%\.dsh-desktop-signing\signature-cache\v1`。缓存目录必须属于当前账户，访问权限不得向其他普通账户开放；带链接的路径会被拒绝。缓存项标识原始字节、公钥证书和签名工具链。每次恢复都检查摘要、Windows 信任状态、时间戳和证书，再替换未签名文件；缓存项无效会停止打包，不回退到硬件签名。不会仅因缓存较旧而重新签名。缓存信任同账户运行的程序，不防御管理员。[运行时签名缓存决策](../../../.agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.zh.md)定义验收要求和设计限制。

预检、主要运行时签名、应用运行时签名和产物生成分别持有账户级签名阶段锁，直到受监督的子进程结束。其他构建进入这些阶段前等待；编译和准备步骤不持锁。运行时签名进程自行持锁，因此仅终止外层打包进程不会释放仍在访问缓存的阶段锁。迁移及维护获取同一把锁；旧版或外部签名命令不参与排队，应另行避免并发。阶段等待不计入预检期限。关闭阶段句柄会释放普通竞争锁，不删除独立的硬件尝试互锁；遗留硬件失败仍需操作人员恢复。

缓存命中的复制、摘要和逐文件候选信任检查使用 `.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY` 个工作任务（默认 `4`，整数 `1`–`8`）。所有恢复完成后，有界 PowerShell 批次逐项验证恢复目标的信任、时间戳和证书，通过后未命中项才进入串行硬件签名。恢复失败会停止派发新的恢复任务并等待在途工作结束；目标验签失败会等待当前检查批次结束并阻止硬件签名。运行时 smoke 检查和最终完整性校验仍须执行。

PE 发现会读取每个普通文件的头部，同时最多打开八个文件，拒绝链接和损坏的 Windows 可执行文件，并在报告失败前等待在途读取和关闭结束。打包将 `windows:enumerate-code` 与 `windows:inspect-signatures` 记录为签名和产物验证的嵌套阶段；其耗时已包含在外层阶段中。

Windows 打包从 `.env.windows` 或所选预设读取 `DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY`：必须为正整数，默认 `4`。Windows 使用有界 worker 批量打包第一方和 vendor tarball，随后校验每个产物并记录发布顺序。完整构建成功后，tarball 打包与 Electron、主要运行时准备在各自输出目录中并行执行。两者都成功结束后才开始运行时签名；准备失败会停止新的打包命令，并等待在途进程结束后返回。设为 `1` 时 tarball worker 串行执行；独立的 `release:pack` 默认使用 `1`。

每个运行时阶段向标准输出及打包日志写入 `SIGNATURE_CACHE_SUMMARY`，包含实际目录、策略标识、命中及未命中数、新发布及保留项数、签名请求数、省去的签名请求数和验证失败数。计时区分签名、恢复文件和新签名文件的信任验证及恢复；恢复耗时包含其信任检查和暂存清理。这些统计不包含预检、最终产物签名及外层运行时验签。阶段锁事件单独记录等待时间。 并发计时累加逐文件工作耗时，不代表阶段墙钟时间。

使用 `pnpm --dir apps/desktop run cache:windows-signatures --usage` 查看结构完整的缓存项字节数和数量，或用 `--from <absolute-old-cache>` 导入显式指定、属于同账户的旧缓存。迁移不修改源目录，跳过暂存名称，拒绝损坏项，并保留已有有效项，即使它们的时间戳字节不同。`--clear` 在阶段锁保护下显式删除完整缓存项；不执行自动容量淘汰。`--directory <absolute-cache>` 指定维护目标目录，无需加载发布凭据。不完整暂存项保持原状并单独计数；仅在所有构建停止后检查它们。这些命令绝不清除硬件失败证据。默认存储位于 AppData 之外，避免 MSIX 启动器虚拟化将账户缓存拆开；被重定向的覆盖目录会明确失败。

<a id="verification"></a>

## 验证范围

签名性能证据与更换机器后的复测由[签名并发验收](../tests/signing-concurrency/README.zh.md)维护。更新与安装证据由[Desktop 验证记录](../tests/README.zh.md)和[已安装更新流程](../tests/installed-update/README.zh.md)维护。本文档不授权 PIN 重试、自动删除 interlock、设备初始化或改变已接受的隔离策略。

经操作人员授权后，可运行 `node apps/desktop/tests/windows-signing-concurrency.perf.ts --execute --config-root <打包配置目录的绝对路径> --rounds 2` 做并发实验。不加 `--execute` 只打印用法。默认比较完全串行、两个完成任务共用单路硬件签名，以及两路硬件签名，每批使用六个合成 PE 副本。第二轮反转模式顺序。

加上 `--corpus <清单 JSON 的绝对路径>` 后，改用真实发布文件比较 1、2、4 个并发任务。清单是非空 JSON 数组，每项包含绝对路径 `path` 及对应的小写十六进制 `sha256`。准备阶段复制哈希固定的文件，验证签名并仅移除副本上的有效签名；签名无效或字节变化会中止准备。移除签名要求 SignTool 支持 `remove /s`；配置中的版本不支持时，可用 `--strip-tool <signtool.exe 的绝对路径>` 仅覆盖这个公开准备工具。硬件签名和时间戳仍使用机器 preset。每批使用经过字节比对的全新无签名模板副本，保持清单顺序。配合语料使用 `--pipeline-control` 时，改为四个完成任务共用一个硬件请求。原文件和发布缓存保持不变。

实验读取机器 test preset，核对公开身份，持有账户签名阶段锁，每批保留一条硬件尝试保护记录。首错停止派发并排空已发出的工作；最多可能已有四条硬件请求在途。只有全部签名、时间戳和文件验证成功才正常释放保护记录。文件从不执行。记录保留在 `.desktop-build/qualification/signing-concurrency`，包含整批及单文件耗时、批次起止时的主机 CPU 计数、可用内存和驱动进程内存采样。内存采样不含子进程，不能用于确定峰值内存。计时不含输入准备、等锁和包组装。重放现成产物还排除了它们之间的构建依赖；实验不启用生产并发，也不代表完整发布性能。

## 开发备注

无。

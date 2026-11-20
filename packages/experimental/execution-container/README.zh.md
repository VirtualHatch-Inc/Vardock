---
description: "在隔离的 Docker 容器或 Apple Linux 虚拟机中运行获准的会话脚本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-container

[English](README.md) | 中文

## 概述

工作会话可以在隔离的 Linux 工作区中运行 shell 脚本。`/workspace` 中的文件随会话保留，可供后续调用和显式续接使用。Docker 工作区除回环外没有网络设备，并在可选择的 OCI 运行时下运行。Apple container 工作区在专用的 Linux 虚拟机中运行，可通过运营方配置的网关访问指定网络目标。配置网关套接字后，两个后端都可以把获准的业务请求交给操作授权服务。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在[操作授权服务](../operation-control/README.zh.md)配置方案中挂载此提供方和 `@deepseek-ai/dsh-subprocess-local`。Agent Host 通过授权服务套接字访问执行能力。

### 最小配置

```yaml
- insert:
    - id: isolated-execution
      name: '@deepseek-ai/dsh-execution-container'
      config:
        backend: docker
        dockerSocket: /run/user/1001/docker.sock
        image: dsh-execution:local
```

使用 Docker 时，请提供授权服务账户拥有的守护进程套接字，并预加载包含 `/bin/sh`、`/bin/sleep` 和 `/bin/chmod` 的可信 Linux 镜像。在守护进程中注册所选的 `runtime`。镜像应无声明的 Docker 卷和嵌入的凭据。对于 Apple 芯片上的 Apple container，请按 [macOS 配置指南](../assistant/vardock/README.zh.md)预加载[执行镜像](Dockerfile)并配置授权服务。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backend` | 必填 | `docker` 或 `apple-vm`。 |
| `image` | 必填 | 预加载的执行镜像引用。 |
| `dockerSocket` | `docker` 必填 | 本地 Docker 守护进程的 Unix 套接字。 |
| `runtime` | `runc` | Docker 的 OCI 运行时：`runc`、`runsc`（gVisor）或 `io.containerd.kata.v2`（Kata Containers）。更改后，现有会话容器会被判定为冲突。 |
| `gatewaySocket` | `apple-vm` 必填；`docker` 可选 | 授权服务账户所有、权限为 `0700` 的目录中的固定 Unix 套接字路径。对于 Docker，设置后启用业务请求。 |
| `allowedTargets` | `[]` | Apple 虚拟机网关允许访问的确切 `host:port` 目标。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-execution-container)列出了可执行文件名、时限和资源限制。授权服务在受理调用前验证预加载的镜像。

Apple 虚拟机无法直接访问网络。网关默认拒绝所有 CONNECT 目标。使用 curl 访问允许的明文 HTTP 目标时，指定 `--proxytunnel`。网关将列出的 DNS 名称解析为公网 IPv4 地址。若要访问内部服务，请明确列出其 IP 字面量和端口。网关会检查每条隧道的目标。应用凭据和授权由目标服务负责。

当后端有网关 socket 时，控制服务可以为 Shell 调用附加业务请求处理器：Apple VM 要求 `allowedTargets` 为空，Docker 要求设置 `gatewaySocket`。Shell 接收 `DSH_BROKER_URL` 和单次调用的 `DSH_BROKER_TOKEN`；传输及没有处理器的调用都不接收它们。两个 CLI 都按名称从进程环境转发这些变量；令牌值不放入 Host argv。使用 HTTP POST 和 `Authorization: Bearer <token>` 发送 UTF-8 JSON。网关接受最多 256 KiB 的请求和 1 MiB 的响应。控制服务定义请求字段、审批规则和结果。[操作控制服务](../operation-control/README.zh.md)

在 Apple 虚拟机中，来宾系统内的 socat 在 `127.0.0.1:3128` 监听，并把每个请求转发到挂载进虚拟机的网关套接字。Docker 容器既没有回环以外的网络设备，也没有挂载的套接字。对于带处理程序的调用，提供方在脚本之前以容器的非 root 用户通过 `docker exec` 启动中继。中继在 `127.0.0.1:3128` 监听，并把每个请求作为一行 JSON 写到标准输出。授权服务进程读取这些行，把每个请求重放到网关套接字，再把响应行写回。网关对其执行与 Apple 虚拟机请求相同的凭据检查、字节限制和排空。中继在容器内以与脚本相同的用户身份运行，因此脚本可以停止、替换或冒充它。凭据检查、各项限制和行协议由 Host 泵和网关执行，而不是由中继执行。Host 拒绝格式错误的行、超长的行、重复使用的请求 ID，以及超过 `gatewayMaxConnections` 的并发请求，随后停止中继并记录警告。已取消的请求在其向网关的重放关闭之前仍计为进行中，其 ID 也仍被占用。镜像必须包含供中继使用的 `/usr/local/bin/node`。

两个后端均支持通过授权服务按原始字节导入输入文件、导出产物。用于传输的可信镜像必须包含 `/usr/local/bin/node`。授权服务可设置文件大小上限，但不得超过提供方的 32 MiB 上限。导入使用 `input/` 下的相对路径，仅当现有文件的字节完全相同时才接受重复导入。导出通过相对路径选择工作区内的普通文件。传输拒绝符号链接和硬链接。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>展开实现细节</summary>

[Docker 执行器](src/docker.ts)按 Harness 主目录和 Session ID 定位容器，并在使用前验证归属标签、镜像、OCI 运行时和限制。冲突的容器以 `EXEC_CONTAINER_CONFLICT` 被拒绝并保持原样。操作员必须先检查其归属和工作区；只有不再需要该工作区时才移除容器。下一次调用会创建新容器和新工作区。执行器配置只读根文件系统、仅回环网络、移除全部 capabilities 并禁止提权。其 `/etc/resolv.conf` 只列出 `127.0.0.1` 且没有搜索域，工作环境看不到 Host 的 DNS 服务器或搜索域。脚本以非 root 的数字用户运行，`/workspace` 使用 Docker 管理的卷。

有处理器的调用会让 Docker 执行器注册凭据、启动容器和[中继](src/relay.ts)，并在执行截止时间内等待就绪。中继就绪后才启动脚本。脚本结束、失败、取消或超时后，执行器撤回凭据、确认容器停止、终止中继命令，并等待已准入请求及中继关闭。在此配置的路径中，未确认的停止不会留下有效凭据或通向网关的存活中继连接。标准输入关闭时，中继以 502 回答待处理请求并退出。

[Apple 虚拟机执行器](src/vm.ts)为每个会话提供独立的微型虚拟机、持久卷和只读根文件系统，除回环外不配置网络设备。来宾系统的非 root 用户通过 vsock 转发的单个 Unix 套接字访问 Host 网关。执行镜像提供 Node.js 和 socat，用于来宾系统的回环代理和启动检查。

执行器通过脚本 CLI 的进程环境传递 `DSH_BROKER_URL` 和 `DSH_BROKER_TOKEN`，并在 `exec --env` 参数中按名称引用，不将令牌值放入 Host argv。在 Linux 上，子进程启动器会短暂地把环境写入权限为 0600、位于权限为 0700 目录中的私有请求文件；引导程序消费该文件时即将其删除。网关将单次调用凭据路由到该调用的处理器，在取消或 Shell 退出时撤回，并在返回结果前等待已准入请求。等待决定时，Shell 截止时间和网关空闲超时仍然适用。

Apple 虚拟机执行器在重新开放网关前，会停止此前分配给该套接字且仍在运行的虚拟机。由此恢复的会话会在下一次调用时报告中断。如果调用期间无法确认虚拟机已停止，执行器会关闭网关并停止受理工作。Apple 虚拟机证据以容器名称的 SHA-256 作为不透明标识。

[服务](src/service.ts)为授权服务的工作区命名空间提供一个执行租约。授权服务等待策略解析完成后才受理工作，并在关闭时释放租约。文件传输独占 shell 所用的工作区，单独启动来宾环境，在确认停止后返回 SHA-256 摘要和字节数。两个后端均在每次调用后停止容器并保留卷，取消调用时亦如此。提供方无法确认停止时会报告结果未知。如果后续调用发现中断的容器仍在运行，提供方会将其停止并报告中断。重复可能已产生部分更改的脚本前，先检查文件。

`@deepseek-ai/dsh-execution-container/library` 导出授权服务在服务之外使用的部分：`createExecTool`、`renderExecutionObservation`、`isWorkspaceTransferPath` 和 `MAX_WORKSPACE_TRANSFER_BYTES`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Assistant](../assistant/README.zh.md) — 角色访问和显式续接工作。
- [子进程服务](../../subprocess/subprocess/README.zh.md) — CLI 进程管理和输出收集。
- [Docker 卷](https://docs.docker.com/engine/storage/volumes/) — 检查及删除保留的存储。

-----

<a id="model-experience"></a>
## 模型体验

操作授权服务通过 [`exec` 工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-operation-control)间接影响模型；其说明列出随附的 shell、Node.js 运行时、代理请求格式，以及脚本和外部请求各自的批准策略，并将受字节限制的命令输出记入会话历史。

#### KV Cache 影响

不变的工具定义可留在缓存前缀中。命令输出作为工具结果进入后续请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 每组工作会话使用一个操作授权服务。后端保留已停止的容器和工作卷，直到运营方移除。切换后端时，请迁移续接工作所需的工作区文件。
- 提供方未提供会话级磁盘配额。
- 同一提供方的所有执行共享网关的 `gatewayMaxConnections`。一个 Docker 中继最多可同时保留这么多业务请求，一个 Apple 虚拟机最多可打开这么多网关连接。在这些请求未完成时，网关会丢弃其他所有执行的请求，相应脚本会看到连接被关闭。由于并发执行的数量没有上限，提供方不为每个执行预留份额。
- Docker 配置只读根文件系统、非 root 用户、无 capabilities、内存与 PID 限制，以及仅回环网络。gVisor 的 PID 设置不限制来宾进程数。配置的通信路径仅经过 Broker，每项请求由控制服务准入；这些设置不能证明可以抵御内核攻破。runc 共享 Host 内核，不是 VM 隔离边界。runsc 使用 gVisor 用户态内核。可正常运行的 Kata 部署在类型上提供 VM 隔离边界并需要 KVM，但本项目尚未验证它。rootful Docker 访问权等同于 Host root 控制权；宿主内核攻破的影响不受 rootless 守护进程账户权限限制。在单账户部署中，该账户持有控制服务凭据、记录和见证数据。
- 在 `runsc` 下，`pidsLimit` 计算沙箱的 Host 任务，在测试主机上空闲时约为 29 个，不限制来宾进程数。设置 `gatewaySocket` 时，Provider 拒绝低于实测运行下限的 `pidsLimit`：`runc` 为 20，`runsc` 为 48。keeper、中继，以及使用 fetch 和线程池运行 Node 脚本的 Shell，在 `runc` 下峰值为 20 个任务，在 `runsc` 下为 45 个。Kata 的运行下限未知。
- Linux 验证范围：一台 arm64 Ubuntu VM，使用 Docker 29.9、runc 1.5 和 gVisor release-20261109。测量包括 16 个约 200 KiB 请求及约 900 KiB 响应的并发中继，以及 `--network none` 下 `docker exec` 进程共享回环网络。Broker 往返时间 p50 为 6 ms（`runc`）和 11 ms（`runsc`）；冷启动为 360–430 ms 和 400–530 ms；空闲内存约为 8 MiB 和 19 MiB。该 VM 上的真实引擎检查覆盖隔离、持久工作区、停止、Broker 传递、凭据失效、并发和取消。这些测量不验证其他主机或运行时；本次发布准备中修改后的测试尚未在 Linux 上重跑。
- 未验证：Kata 未能在测试 VM 的嵌套虚拟化中启动；其 VM 隔离和运行限制仍未经本项目验证。请在具备可用 KVM 的主机上评估。x86_64、其他 Linux 发行版和 rootless Docker 也未经验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>展开维护背景</summary>

设置 `DSH_EXEC_TEST_SOCKET` 和 `DSH_EXEC_TEST_IMAGE` 后可运行 Docker 冒烟测试；`DSH_EXEC_TEST_RUNTIME` 选择运行时。镜像需要 `/usr/local/bin/node`，例如[执行镜像](Dockerfile)。在 macOS 上启动 Apple container 并设置 `DSH_EXEC_VM_TEST_IMAGE` 后可运行 Apple 虚拟机冒烟测试。在 Linux 上，同样的 Docker 变量还会让 `pnpm run test:e2e` 端到端运行 [operation-control](../operation-control/tests/socket-restart.e2e.ts) 的业务用例。这些测试只创建和删除使用自身随机会话 ID 的容器。

</details>

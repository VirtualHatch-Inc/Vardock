---
kind: upgrade-guide
description: "owner 的 Remote 调用必须提供有效的访问资源。"
---

# 校验 owner Remote 调用的资源

[English](guide.md) | 中文

## 变更

Gateway 对 owner 与非 owner 的调用都会解析资源。两种调用的资源无效时，均返回 `remote-access/denied`，且 `details.reason` 为 `resource-invalid`。这影响传入无效资源标识的 Remote 调用方，以及资源读取函数无法处理 owner 输入的插件方法。

## 迁移

1. 请求中指明的资源标识应为非空字符串。对于自定义 Remote 方法，检查 [`@Remote` 和 `@RemoteScope` 的资源读取函数](../../../api-gateway.zh.md#programming-model)，以及方法使用的 lookup、Context 或默认资源声明。
2. 使用有效标识重试 owner 调用，确认方法收到该标识。若有意发送无效请求，处理原因为 `resource-invalid` 的 `remote-access/denied`。

---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-assistant-artifact-metadata

[English](2026-11-10-assistant-artifact-metadata.md) | 中文

## 概述

为 Assistant 工作结果来源添加可选的已见证成果文件元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-assistant-artifact-metadata
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-assistant-work"
    after: "b1f151378a4731df7f9d5ed6a7163740b733ed5d93030ab97bdff0aed468a7a1"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-assistant-work"
    after: "f84dfb959a351eaa0f165f2cbc13f33a4bc7313f2602f8fd99f586e5281df710"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-assistant-work"
    after: "19d6bba3c41cd6c82cc58ef577ac339e384f9267ecb8865eb63f900feadd81f2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-assistant-work"
    after: "89df9ae8fe2e79f2c14ba379589754e5504ba5758ee19f2b22321daf488aef65"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

字段可选，因此已有 Session 记录仍有效。旧读取方忽略成果文件元数据并保留原有结果通知；新读取方仅在元数据存在时显示下载。元数据包含名称、字节数和内容摘要，不包含文件内容或宿主路径。仅所有者可访问的下载重新检查授权发布结果及当前工作权限。回放显示已有通知，不重复导出。

<a id="verification"></a>
## 验证

Assistant 数据、协调器和仲介专项测试通过 46 项；成果文件组件与入口测试通过 6 项。Apple VM 二进制传输冒烟测试通过，验证了精确的导入导出字节和符号链接拒绝。

<a id="dev-note"></a>
## 开发备注

无。

---
kind: upgrade-guide
description: "Custom Agent drivers must implement wake() to start processing input already in the inbox."
---

# Custom Agent drivers implement `wake()`

English | [中文](guide.zh.md)

## Change

The public `Agent` interface from `@deepseek-ai/dsh-agent` requires a `wake(): void` method. This affects custom drivers and test doubles that implement `Agent`.

## Migration

1. Implement [`Agent.wake()`](../../../subsystems/core.md#the-agent-handle) using your driver's existing start path. Preserve pending inbox positions, defer the wake during active work, and skip it when the inbox is empty or disposal is underway.
2. Type-check the implementation against `Agent`. Queue an input with `send(message, target, false)`, call `wake()`, and confirm the driver processes that message once.

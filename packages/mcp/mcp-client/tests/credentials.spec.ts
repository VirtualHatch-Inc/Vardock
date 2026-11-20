/** Runtime credential templates resolve per pass and every resolved value is redacted from diagnostics. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, probeServer, type StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { callServerTool } from '@deepseek-ai/dsh-mcp-client/call'
import { McpTemplateBinding } from '@deepseek-ai/dsh-mcp-client/src/credentials.ts'
import { TestCredentials } from './credential-fixture.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

const ref = credentialRef('MCP_TOKEN')
const url = 'https://mcp.invalid/fixture'

function httpConfig(): StreamableHttpConfig {
  // The literal transport selects the Streamable HTTP branch of the validated union.
  return Config({ transport: 'streamable-http', serverName: 'binding', url,
    headers: { Authorization: 'Bearer ${credential:MCP_TOKEN}' }, expandTemplates: true }) as StreamableHttpConfig
}

describe('McpTemplateBinding', () => {
  let ctx: Context
  let provider: TestCredentials
  let providerFiber: Fiber

  beforeEach(async () => {
    ctx = new Context()
    providerFiber = await ctx.plugin(TestCredentials)
    provider = ctx.credentials as TestCredentials
    provider.values.set(ref, 'first-token')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
  })

  it('requires a provider when binding credential templates', async () => {
    await providerFiber.dispose()
    expect(() => new McpTemplateBinding(ctx, httpConfig())).toThrow('require a credentials provider')
  })

  it('resolves repeated references once per pass while keeping configuration unexpanded', async () => {
    const config = Config({ transport: 'stdio', serverName: 'binding', expandTemplates: true,
      command: 'fixture-command', args: ['${credential:MCP_TOKEN}', '${credential:MCP_TOKEN}'],
      env: { TOKEN: '${credential:MCP_TOKEN}' }, cwd: '' })
    const binding = new McpTemplateBinding(ctx, config)
    const resolve = vi.spyOn(provider, 'resolve')
    const signal = new AbortController().signal
    expect(await binding.resolve(signal)).toMatchObject({ command: 'fixture-command',
      args: ['first-token', 'first-token'], env: { TOKEN: 'first-token' }, cwd: '' })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ref)
    expect(config).toMatchObject({ args: ['${credential:MCP_TOKEN}', '${credential:MCP_TOKEN}'] })
    provider.values.set(ref, 'next-token')
    expect(await binding.resolve(signal)).toMatchObject({ args: ['next-token', 'next-token'] })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('reports a provider unloaded after binding creation at the next resolution', async () => {
    const binding = new McpTemplateBinding(ctx, httpConfig())
    await providerFiber.dispose()
    await expect(binding.resolve(new AbortController().signal)).rejects.toThrow('require a credentials provider')
  })

  it('redacts every resolved value, including rotated and URL-encoded forms', async () => {
    provider.values.set(ref, 'first/token')
    const binding = new McpTemplateBinding(ctx, httpConfig())
    const signal = new AbortController().signal
    await binding.resolve(signal)
    provider.values.set(ref, 'next-token')
    await binding.resolve(signal)
    provider.values.set(ref, '')
    await binding.resolve(signal)
    const upstream = new Error('rejected first/token, first%2Ftoken and next-token', { cause: new Error('echo next-token') })
    expect(binding.diagnostic(upstream, 'startup')).toBe(
      'mcp-client(binding): startup: Error: rejected [redacted], [redacted] and [redacted], cause: echo [redacted]')
    expect(binding.redact('no secret here')).toBe('no secret here')
  })

  it('keeps literal diagnostics unprefixed and unredacted', () => {
    const binding = new McpTemplateBinding(ctx, Config({ ...httpConfig(), expandTemplates: false }))
    expect(binding.diagnostic(new Error('Bearer ${credential:MCP_TOKEN}'), 'startup')).toBe('Error: Bearer ${credential:MCP_TOKEN}')
  })

  it('probes with expanded HTTP credentials without calling any tool', async () => {
    const server = await startHttpMcpFixture()
    try {
      const config = Config({ ...httpConfig(), transport: 'streamable-http', url: server.url })
      const result = await probeServer(ctx, config)
      expect(result).toMatchObject({ ok: true, toolNames: ['ping'], closeConfirmed: true })
      expect(result.cleanupError).toBeUndefined()
      expect(server.authorization.length).toBeGreaterThan(0)
      expect(server.authorization.every(value => value === 'Bearer first-token')).toBe(true)
      expect(server.calls).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('calls one tool with expanded HTTP credentials and closes the connection', async () => {
    const server = await startHttpMcpFixture()
    try {
      const config = { ...httpConfig(), url: server.url }
      expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 65_536)).toEqual({ ok: true, isError: false, text: 'pong', closeConfirmed: true })
      expect(server.calls).toEqual(['ping'])
      expect(server.authorization.every(value => value === 'Bearer first-token')).toBe(true)
      const aborted = new AbortController()
      aborted.abort()
      expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 65_536, aborted.signal))
        .toMatchObject({ ok: false, stage: 'connect', message: 'call aborted' })
      expect(server.calls).toEqual(['ping'])
    } finally {
      await server.close()
    }
  })

  it('redacts the credential from a tool error and reports a failed connection as not called', async () => {
    const server = await startHttpMcpFixture({ rejectToolCalls: true })
    const config = { ...httpConfig(), url: server.url }
    try {
      expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 65_536))
        .toEqual({ ok: true, isError: true, text: 'MCP fixture rejected Bearer [redacted]', closeConfirmed: true })
    } finally {
      await server.close()
    }
    expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 65_536)).toMatchObject({ ok: false, stage: 'connect' })
  })

  it('stops reading at the read bound and classifies the failure by whether the call was sent', async () => {
    const server = await startHttpMcpFixture({ reply: 'x'.repeat(100_000) })
    const config = { ...httpConfig(), url: server.url }
    try {
      expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 1))
        .toMatchObject({ ok: false, stage: 'connect', message: 'server responses exceeded 1 bytes' })
      expect(server.calls).toEqual([])
      expect(await callServerTool(ctx, config, { name: 'ping', arguments: {} }, 65_536))
        .toMatchObject({ ok: false, stage: 'call', message: 'server responses exceeded 65536 bytes', closeConfirmed: true })
      expect(server.calls).toEqual(['ping'])
    } finally {
      await server.close()
    }
  })
})

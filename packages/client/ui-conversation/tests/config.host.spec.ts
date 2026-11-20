import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { volatileForm, plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const configuration = await liveConfig(ctx, HostPlugin)
    expect(Object.keys(volatileForm(HostPlugin.Config)?.dict ?? {})).toEqual(expect.arrayContaining([
      'showWorkspacePicker', 'heroTitle', 'showHeroBadge', 'plainPlaceholder',
    ]))
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, showWorkspacePicker: true, showHeroBadge: true, plainPlaceholder: false,
    })
    await configuration.update({ busyEnter: 'steer' })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({
      busyEnter: 'steer', showWorkspacePicker: true, showHeroBadge: true, plainPlaceholder: false,
    })
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(async (ctx) => {
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx.plugin(HostPlugin)
}))

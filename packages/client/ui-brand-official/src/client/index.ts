/** Sidebar and home brand occupants for the selected client build. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PixelWhale } from './home-whale/PixelWhale.tsx'
import { OfficialBrandMark, OfficialBrandName, VardockMark, VardockName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar and home brand slots selected by the client build profile.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame',
    id: 'pixel-whale',
  }, PixelWhale))
  const profile = process.env.DSH_CLIENT_BUILD_PROFILE
  if (profile === undefined) {
    ctx.slots.inject('conversation.hero.brand.mark', () =>
      ctx.slots.register({ name: 'conversation.hero.brand.mark' }, VardockMark))
  }
  if (profile !== undefined && profile !== 'official') return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, profile === 'official' ? OfficialBrandMark : VardockMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, profile === 'official' ? OfficialBrandName : VardockName)
    }))
}

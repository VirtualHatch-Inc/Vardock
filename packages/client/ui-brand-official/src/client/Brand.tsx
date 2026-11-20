import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import logoUrl from './assets/vardock-logo.png'
import lightLogoUrl from './assets/vardock-logo-light.png'
import markUrl from './assets/vardock-mark.svg'
import darkMarkUrl from './assets/vardock-mark-dark.svg'
import css from './Brand.module.css'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}

/**
 * Render the V mark at the size requested by the sidebar or home.
 * The dark theme shows the white stroke and the light theme the navy stroke.
 * @param props - Mark size and optional host class.
 * @returns Decorative mark artwork.
 */
export function VardockMark({ size, className }: HeroBrandMarkOwnerProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 710 488"
    >
      <image className={css.onLight} href={markUrl} width="710" height="488" />
      <image className={css.onDark} href={darkMarkUrl} width="710" height="488" />
    </svg>
  )
}

/**
 * Show the name region of the supplied logo next to the separately slotted mark.
 * The dark theme shows the white lettering and the light theme its dark counterpart.
 * @returns Decorative wordmark artwork.
 */
export function VardockName() {
  return (
    <svg aria-hidden="true" className={css.name} width="120" height="24" viewBox="430 265 790 160">
      <image className={css.onLight} href={lightLogoUrl} width="1280" height="720" />
      <image className={css.onDark} href={logoUrl} width="1280" height="720" />
    </svg>
  )
}

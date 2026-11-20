/**
 * Render the browser and launcher icons from the supplied Vardock mark.
 * Run `pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons`
 * after replacing the source.
 * @module render-app-icons
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** The V mark on a transparent backdrop, shared with the sidebar and conversation hero. */
export const MARK_SOURCE = fileURLToPath(new URL(
  '../../../packages/client/ui-brand-official/src/client/assets/vardock-mark.svg', import.meta.url,
))

/** Directory the generated launcher icons are committed to. */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))

/** Radius a platform mask is guaranteed to show, as a fraction of the icon edge. */
export const MASKABLE_SAFE_RADIUS_RATIO = 0.4

/** Committed install icon filenames, square edges in pixels, and artwork extents relative to the tile. */
export const APP_ICON_VARIANTS = [
  { file: 'icon-192.png', size: 192, artworkScale: 0.86 },
  { file: 'icon-512.png', size: 512, artworkScale: 0.86 },
  { file: 'icon-maskable-512.png', size: 512, artworkScale: 0.64 },
  { file: 'apple-touch-icon.png', size: 180, artworkScale: 0.86 },
] as const

/**
 * Committed tab icon. It lives in `src/` so the build names it by content hash:
 * browsers retain a tab icon per URL and keep showing the old image at an unchanged URL.
 */
export const FAVICON_PATH = fileURLToPath(new URL('../src/favicon.svg', import.meta.url))

/**
 * Render the committed launcher icons on opaque tiles and the tab icon, an SVG copy of the mark
 * whose navy stroke turns white under a dark browser color scheme so dark tab strips show it.
 * @param source - V mark SVG.
 * @returns Each output path and its encoded bytes.
 */
export async function renderAppIcons(source: Buffer): Promise<readonly { path: string; bytes: Buffer }[]> {
  const markSource = await sharp(source).trim().png().toBuffer()
  const tiles = await Promise.all(APP_ICON_VARIANTS.map(async ({ file, size, artworkScale }) => {
    const edge = Math.round(size * artworkScale)
    const artwork = await sharp(markSource).resize(edge, edge, { fit: 'inside' }).png().toBuffer()
    const bytes = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
      .composite([{ input: artwork }]).png().toBuffer()
    return { path: resolve(ICON_OUTPUT_DIRECTORY, file), bytes }
  }))
  const favicon = source.toString('utf8').replace(
    /(<svg[^>]*>)/u, '$1<style>@media (prefers-color-scheme: dark){path[fill="#071126"]{fill:#fff}}</style>',
  )
  return [...tiles, { path: FAVICON_PATH, bytes: Buffer.from(favicon) }]
}

async function main(): Promise<void> {
  const icons = await renderAppIcons(await readFile(MARK_SOURCE))
  await Promise.all(icons.map(({ path, bytes }) => writeFile(path, bytes)))
  console.info(`app icons: wrote ${icons.map(icon => icon.path).join(', ')}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()

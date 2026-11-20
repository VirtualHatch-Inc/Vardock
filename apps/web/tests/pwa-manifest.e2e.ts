import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'
import {
  APP_ICON_VARIANTS, MASKABLE_SAFE_RADIUS_RATIO,
} from '../scripts/render-app-icons.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

async function pixels(page: Page, url: string, size: number) {
  return page.evaluate(async ({ url, size }) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, size, size)
    const { data } = context.getImageData(0, 0, size, size)
    let radius = 0
    let ink = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4
        const background = data[3]! >= 64 && [0, 1, 2].reduce((sum, c) => sum + Math.abs(data[at + c]! - data[c]!), 0) < 100
        if (data[at + 3]! < 64 || background) continue
        ink += 1
        radius = Math.max(radius, Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2))
      }
    }
    return {
      width: image.naturalWidth, height: image.naturalHeight, radius, ink,
      corners: [0, size - 1, (size - 1) * size, size * size - 1].map(index => data[index * 4 + 3]),
    }
  }, { url, size })
}

function pngUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="mobile-web-app-capable" content="yes" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-title" content="Vardock" />')
  // No `theme-color` here: `ThemePresenter` owns the single metadata node and
  // follows the resolved in-application theme, which a static media query
  // cannot. The manifest's `theme_color` covers the surrounding chrome before
  // the presenter runs, and `settings-chrome.e2e.ts` pins the live contract.

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'Vardock',
    short_name: 'Vardock',
    start_url: './',
    scope: './',
    // `standalone` keeps the phone's status bar; `fullscreen` hides it and the
    // navigation bar, which strands a chat surface with no clock or battery.
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('decodes every shipped launcher icon with opaque corners and visible mark artwork', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const { file, size } of APP_ICON_VARIANTS) {
      const png = await readFile(join(DIST_ROOT, file))
      const icon = await pixels(page, pngUrl(png), size)
      expect([icon.width, icon.height], file).toEqual([size, size])
      expect(icon.corners, file).toEqual([255, 255, 255, 255])
      expect(icon.ink, file).toBeGreaterThan(size * size * 0.1)
    }
  } finally { await browser.close() }
})

it('links one mark tab icon named by its content hash that stays visible on dark tab strips', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  const links = [...index.matchAll(/<link rel="icon" type="image\/svg\+xml" href="\.\/(assets\/favicon-[\w-]+\.svg)"/gu)]
  expect(index.match(/<link rel="icon"/gu)).toHaveLength(1)
  expect(links).toHaveLength(1)
  const url = `data:image/svg+xml;base64,${(await readFile(join(DIST_ROOT, links[0]![1]!))).toString('base64')}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      const stroke = await page.evaluate(async (url) => {
        const image = new Image()
        image.src = url
        await image.decode()
        const context = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }).getContext('2d')!
        context.drawImage(image, 0, 0, 32, 32)
        const { data } = context.getImageData(0, 0, 32, 32)
        const counts = { navy: 0, white: 0 }
        for (let at = 0; at < data.length; at += 4) {
          const sum = data[at]! + data[at + 1]! + data[at + 2]!
          if (data[at + 3]! > 128 && sum < 100) counts.navy += 1
          if (data[at + 3]! > 128 && sum > 700) counts.white += 1
        }
        return counts
      }, url)
      expect(stroke.navy > 64 && stroke.white === 0, colorScheme).toBe(colorScheme === 'light')
      expect(stroke.white > 64 && stroke.navy === 0, colorScheme).toBe(colorScheme === 'dark')
    }
  } finally { await browser.close() }
})

it('keeps the maskable icon inside its platform safe zone', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const size = 512
    const maskable = await readFile(join(DIST_ROOT, 'icon-maskable-512.png'))
    const regular = await readFile(join(DIST_ROOT, 'icon-512.png'))
    const masked = await pixels(page, pngUrl(maskable), size)
    const unmasked = await pixels(page, pngUrl(regular), size)
    expect(masked.radius).toBeLessThanOrEqual(MASKABLE_SAFE_RADIUS_RATIO * size)
    expect(unmasked.radius).toBeGreaterThan(MASKABLE_SAFE_RADIUS_RATIO * size)
  } finally { await browser.close() }
})

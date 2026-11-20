/** Committed Web icon dimensions and reproducibility from the shared mark. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, FAVICON_PATH, ICON_OUTPUT_DIRECTORY, MARK_SOURCE, renderAppIcons,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web application icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('renders the committed tab icon from the shared mark', async () => {
    const outputs = await renderAppIcons(await readFile(MARK_SOURCE))
    const favicon = outputs.find(output => output.path === FAVICON_PATH)!.bytes
    expect(favicon.equals(await readFile(FAVICON_PATH))).toBe(true)
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })
})

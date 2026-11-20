import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { desktopBuildVersionPrefix } from '../scripts/desktop-build-version.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it.each(['arm64', 'x64'] as const)('embeds stable in a prerelease macOS %s package and provider', (arch) => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const version = `${desktopBuildVersionPrefix(manifest.version)}20261103.1`
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.channel-test',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
    DSH_DESKTOP_BUILD_VERSION: version,
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
    DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'channel-test',
  }, 'darwin', arch)
  expect(config.extraMetadata).toMatchObject({ version, dshDesktopUpdateChannel: 'stable' })
  expect(config.publish).toEqual([{ provider: 'generic', url: `https://download.deepseek.com/dsh-desk/feeds/mac-${arch}/`, channel: 'stable' }])
})

it('accepts a stable prerelease in an unsigned Windows x64 configuration', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const version = `${desktopBuildVersionPrefix(manifest.version)}20261103.1`
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.channel-test',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
    DSH_DESKTOP_BUILD_VERSION: version,
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_UNSIGNED: '1',
  }, 'win32', 'x64')
  expect(config.extraMetadata).toMatchObject({ version })
  expect(config.publish).toBeNull()
})

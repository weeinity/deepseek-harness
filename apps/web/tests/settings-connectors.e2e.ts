/** Real Web connector controls with isolated profile storage and a local MCP fixture. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/settings-connectors', import.meta.url))
const MODE = webSnapshotMode()
const MCP = '@deepseek-ai/dsh-mcp-client'
const MARKS = [
  { name: 'ado', artworkSize: 78 },
  { name: 'icm', artworkSize: 84 },
  { name: 'kusto', artworkSize: 78 },
  { name: 'enghub', artworkSize: 78 },
  { name: 'ecs', artworkSize: 78 },
  { name: 'teams', artworkSize: 78 },
  { name: 'workiq', color: 'rgb(181, 101, 31)', size: 18 },
  { name: 'reference_memory', color: 'rgb(176, 71, 127)', size: 18 },
  { name: 'obsidian', artworkSize: 102 },
  { name: 'exa', color: 'rgb(43, 43, 51)', size: 18 },
  { name: 'bluebird', color: 'rgb(47, 159, 212)', size: 19 },
] as const

describe('web e2e: MCP connector settings', () => {
  let directory: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-connectors-web-'))
    const overlay = join(directory, 'connectors.patch.yml')
    await writeFile(overlay, JSON.stringify([{ insert: [
      ...[...MARKS.filter(mark => mark.name !== 'workiq').map(mark => mark.name), 'mrd'].map(serverName => ({
        id: `connector-${serverName}`, name: MCP, disabled: true,
        config: { serverName, transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
      })),
      {
        id: 'connector-workiq', name: MCP,
        config: {
          serverName: 'WorkIQ', transport: 'stdio', command: process.execPath,
          args: [join(REPO_ROOT, 'packages', 'mcp', 'mcp-client', 'tests', 'fixture-server.ts')],
          failOnStartupError: true, reconnect: { enabled: false },
        },
      },
    ] }]) + '\n')
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, profileConnectorControls: true })
    await writeFile(join(scaffold.harnessHome, 'cordis.patch.yml'),
      JSON.stringify([{ id: 'connector-exa', name: MCP, disabled: true }]) + '\n')
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true })
      }
    }
  })

  async function open(page: Page, locale: 'en' | 'zh') {
    if (scaffold === undefined) throw new Error('Connector scaffold is not ready')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click()
    await page.getByRole('button', { name: locale === 'en' ? 'Connectors' : '连接器', exact: true }).click()
    await page.getByRole('switch', { name: locale === 'en' ? 'Enable WorkIQ' : '启用 WorkIQ' }).waitFor()
  }

  async function assertMarks(page: Page) {
    for (const mark of MARKS) {
      const tile = page.locator(`[data-connector-mark="${mark.name}"]`)
      expect(await tile.evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const control = element.closest('li')!.querySelector('[role="switch"]')!.getBoundingClientRect()
        return {
          width: rect.width,
          height: rect.height,
          radius: style.borderRadius,
          centerOffset: rect.y + rect.height / 2 - control.y - control.height / 2,
          highlight: getComputedStyle(element, '::after').boxShadow,
        }
      })).toEqual({
        width: 34, height: 34, radius: '9px', centerOffset: 0,
        highlight: 'rgba(255, 255, 255, 0.14) 0px 1px 0px 0px inset',
      })
      expect(await tile.getAttribute('aria-hidden')).toBe('true')
      if ('color' in mark) {
        expect(await tile.evaluate(element => ({
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          width: element.querySelector('svg')!.getBoundingClientRect().width,
          height: element.querySelector('svg')!.getBoundingClientRect().height,
        }))).toEqual({ background: mark.color, color: 'rgb(255, 255, 255)', width: mark.size, height: mark.size })
      } else {
        const image = tile.locator('img')
        await image.evaluate((element: HTMLImageElement) => element.decode())
        expect(await image.evaluate((element: HTMLImageElement) => ({
          inline: element.currentSrc.startsWith('data:image/png;base64,'),
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          fit: getComputedStyle(element).objectFit,
          radius: getComputedStyle(element).borderRadius,
          opacity: getComputedStyle(element).opacity,
          alt: element.alt,
        }))).toEqual({
          inline: true, naturalWidth: 102, naturalHeight: 102,
          width: 34, height: 34, fit: 'contain', radius: '9px', opacity: '1', alt: '',
        })
        const ink = await image.evaluate((element: HTMLImageElement, name) => {
          const canvas = document.createElement('canvas')
          canvas.width = element.naturalWidth
          canvas.height = element.naturalHeight
          const context = canvas.getContext('2d')!
          context.drawImage(element, 0, 0)
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
          const background = name === 'icm' ? [0, 120, 212] : [255, 255, 255]
          let left = canvas.width
          let top = canvas.height
          let right = -1
          let bottom = -1
          for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
              const offset = (y * canvas.width + x) * 4
              if (data[offset + 3]! < 128 || !background.some((channel, index) => Math.abs(data[offset + index]! - channel) > 32)) continue
              left = Math.min(left, x)
              top = Math.min(top, y)
              right = Math.max(right, x)
              bottom = Math.max(bottom, y)
            }
          }
          return {
            extent: Math.max(right - left + 1, bottom - top + 1),
            x: (left + right + 1 - canvas.width) / 2,
            y: (top + bottom + 1 - canvas.height) / 2,
          }
        }, mark.name)
        expect(ink.extent, `${mark.name} artwork size`).toBeGreaterThanOrEqual(mark.artworkSize - (mark.name === 'obsidian' ? 6 : 1))
        expect(ink.extent, `${mark.name} artwork size`).toBeLessThanOrEqual(mark.artworkSize)
        expect(Math.abs(ink.x), `${mark.name} horizontal alignment`).toBeLessThanOrEqual(1)
        expect(Math.abs(ink.y), `${mark.name} vertical alignment`).toBeLessThanOrEqual(1)
      }
    }
  }

  it('keeps one ordered list while persisting keyboard toggles through the real Host API', async () => {
    if (browser === undefined || scaffold === undefined) throw new Error('Connector scaffold is not ready')
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-connectors'))
    const tripwire = watchConsole(page)
    await open(page, 'en')
    const section = page.getByRole('region', { name: 'Connectors', exact: true })
    const workiq = page.getByRole('switch', { name: 'Enable WorkIQ' })
    const search = page.getByRole('searchbox', { name: 'Search connectors' })
    const rows = section.getByRole('listitem')
    const order = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-connector-id')))
    expect(await workiq.getAttribute('aria-checked')).toBe('true')
    expect(await section.getByRole('list').count()).toBe(1)
    expect(await section.getByRole('heading', { level: 3 }).count()).toBe(0)
    expect(await rows.count()).toBe(12)
    expect(await rows.last().getAttribute('aria-label')).toBe('WorkIQ')
    expect(await section.locator('[data-connector-mark] svg').count()).toBe(4)
    expect(await section.locator('[data-connector-mark] img').count()).toBe(7)
    await assertMarks(page)
    const monogram = section.locator('[data-connector-mark="monogram"]')
    expect(await monogram.textContent()).toBe('MR')
    expect(await monogram.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(244, 244, 246)')
    const exa = section.getByRole('listitem', { name: 'exa', exact: true })
    expect(await exa.getByRole('switch').isDisabled()).toBe(true)
    expect(await exa.getByRole('switch').getAttribute('aria-disabled')).toBe('true')
    expect(await exa.locator('svg[width="12"]').getAttribute('aria-hidden')).toBe('true')
    expect(await exa.getByText('A higher-priority configuration overrides this connector.').isVisible()).toBe(true)
    expect(await section.getByRole('listitem').first().evaluate(element => element.getBoundingClientRect().height)).toBe(76)
    expect(await search.evaluate(element => element.parentElement!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    await compareOrRefreshGolden(join(EXPECTED, 'connectors.expected.md'),
      await captureStableAria(page, `section[aria-labelledby=${JSON.stringify(await section.getAttribute('aria-labelledby'))}]`, scaffold.workspaceCwd), MODE)

    const light = await section.getByRole('list').evaluate(element => getComputedStyle(element).backgroundColor)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => section.getByRole('list').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(light)
    await assertMarks(page)
    expect(await monogram.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(58, 58, 58)')
    await search.fill('  EXA  ')
    expect(await section.getByRole('switch').count()).toBe(1)
    expect(await page.getByRole('switch', { name: 'Enable exa' }).isVisible()).toBe(true)
    await search.fill('missing')
    expect(await section.getByRole('status').textContent()).toBe('No connectors match your search.')
    await search.fill('')

    await workiq.focus()
    const originalSwitch = (await workiq.elementHandle())!
    const enabledPosition = await workiq.boundingBox()
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    await page.route('**/api/connectors/setEnabled', async (route) => {
      await writeGate
      await route.continue()
    })
    try {
      await page.keyboard.press('Space')
      await expect.poll(() => workiq.isDisabled()).toBe(true)
      expect(await workiq.boundingBox()).toEqual(enabledPosition)
      expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-connector-id')))).toEqual(order)
    } finally {
      releaseWrite()
    }
    await page.getByRole('switch', { name: 'Enable WorkIQ', checked: false }).waitFor()
    await page.unroute('**/api/connectors/setEnabled')
    await expect.poll(() => workiq.isDisabled()).toBe(false)
    expect(await workiq.evaluate((element, original) => element === original, originalSwitch)).toBe(true)
    expect(await workiq.boundingBox()).toEqual(enabledPosition)
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-connector-id')))).toEqual(order)
    expect(await workiq.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await section.locator('[data-connector-mark="workiq"]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(181, 101, 31)')
    const profilePatch = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    expect(loadOptionalPatches('connector browser test', profilePatch)).toEqual([
      { id: 'connector-workiq', name: MCP, disabled: true },
    ])
    await originalSwitch.dispose()
    await open(page, 'en')
    expect(await workiq.getAttribute('aria-checked')).toBe('false')
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-connector-id')))).toEqual(order)
    await workiq.scrollIntoViewIfNeeded()
    const disabledPosition = await workiq.boundingBox()
    await workiq.click()
    await page.getByRole('switch', { name: 'Enable WorkIQ', checked: true }).waitFor()
    await expect.poll(() => workiq.isDisabled()).toBe(false)
    expect(await workiq.boundingBox()).toEqual(disabledPosition)
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-connector-id')))).toEqual(order)
    expect(await workiq.evaluate(element => document.activeElement === element)).toBe(true)
    expect(loadOptionalPatches('connector browser test', profilePatch)).toEqual([
      { id: 'connector-workiq', name: MCP, disabled: false },
    ])
    expect(await readFile(profilePatch, 'utf8')).not.toContain('command:')
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  }, 120_000)

  it('renders the connector controls in Chinese', async () => {
    if (browser === undefined || scaffold === undefined) throw new Error('Connector scaffold is not ready')
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-connectors-zh'))
    const tripwire = watchConsole(page)
    await open(page, 'zh')
    const section = page.getByRole('region', { name: '连接器', exact: true })
    expect(await section.getByRole('searchbox', { name: '搜索连接器' }).count()).toBe(1)
    expect(await section.getByRole('list').count()).toBe(1)
    expect(await section.getByRole('heading', { level: 3 }).count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'connectors-zh.expected.md'),
      await captureStableAria(page, `section[aria-labelledby=${JSON.stringify(await section.getAttribute('aria-labelledby'))}]`, scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the expected-output inventory complete', async () => {
    await assertFixtureInventory(EXPECTED, ['connectors.expected.md', 'connectors-zh.expected.md'])
  })
})

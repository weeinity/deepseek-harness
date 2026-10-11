// @vitest-environment jsdom
/** Identity marks remain decorative and independent of MCP transport or state. */
import { cleanup, render } from '@testing-library/react'
import {
  BirdIcon, BrainIcon, BriefcaseIcon, MagnifyingGlassIcon, PlugIcon,
} from '@phosphor-icons/react/ssr'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorMark } from '../src/client/ConnectorMark.tsx'
import logos from '../src/client/connector-logos.ts'

afterEach(cleanup)

describe('ConnectorMark', () => {
  it.each(['ado', 'icm', 'kusto', 'obsidian', 'enghub', 'ecs', 'teams'] as const)(
    'renders the bundled %s logo without an external image request', (name) => {
      const { container } = render(<ConnectorMark name={name} />)
      const tile = container.querySelector(`[data-connector-mark="${name}"]`)!
      const image = tile.querySelector('img')!
      expect(tile.getAttribute('aria-hidden')).toBe('true')
      expect(image.getAttribute('src')).toBe(logos[name])
      expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
      expect(image.getAttribute('alt')).toBe('')
      expect(image.width).toBe(34)
      expect(image.height).toBe(34)
      expect(tile.querySelector('svg')).toBeNull()
    },
  )

  it.each([
    ['workiq', BriefcaseIcon, 18],
    ['reference_memory', BrainIcon, 18],
    ['exa', MagnifyingGlassIcon, 18],
    ['bluebird', BirdIcon, 19],
  ] as const)('renders the prescribed filled %s glyph', (name, Expected, size) => {
    const { container, rerender } = render(<ConnectorMark name={name} />)
    const tile = container.querySelector('[data-connector-mark]')!
    expect(tile.getAttribute('data-connector-mark')).toBe(name)
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    const svg = tile.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe(String(size))
    expect(svg.getAttribute('height')).toBe(String(size))
    const paths = svg.innerHTML
    rerender(<Expected weight="fill" />)
    expect(paths).toBe(container.querySelector('svg')!.innerHTML)
  })

  it.each([['  ObSiDiAn  ', 'obsidian', 'img'], ['  WORKiq  ', 'workiq', 'svg'], ['  TeAmS  ', 'teams', 'img']])(
    'normalizes surrounding whitespace and case for %s', (name, identity, element) => {
      const { container } = render(<ConnectorMark name={name} />)
      expect(container.querySelector(`[data-connector-mark="${identity}"] ${element}`)).not.toBeNull()
    },
  )

  it.each([['mrd', 'MR'], ['custom-search', 'CU'], ['constructor', 'CO'], ['知识库', '知识'], ['ßx', 'SS']] as const)(
    'uses a neutral monogram for %s rather than a transport icon', (name, expected) => {
      const { container } = render(<ConnectorMark name={name} />)
      const tile = container.querySelector('[data-connector-mark="monogram"]')!
      expect(tile.textContent).toBe(expected)
      expect(tile.querySelector('svg')).toBeNull()
    },
  )

  it.each([undefined, '', '   '])('uses the filled plug when the name is absent or blank (%j)', (name) => {
    const { container, rerender } = render(name === undefined ? <ConnectorMark /> : <ConnectorMark name={name} />)
    const paths = container.querySelector('[data-connector-mark="unnamed"] svg')!.innerHTML
    rerender(<PlugIcon weight="fill" />)
    expect(paths).toBe(container.querySelector('svg')!.innerHTML)
  })

  it.each(['ado', 'workiq', 'custom', ''])('accepts an application-owned logo override for %j at the same size', (name) => {
    const { container } = render(<ConnectorMark name={name} logoSrc="/assets/connector.svg" />)
    const tile = container.querySelector('[data-connector-mark="logo"]')!
    const image = tile.querySelector('img')!
    expect(image.getAttribute('src')).toBe('/assets/connector.svg')
    expect(image.getAttribute('alt')).toBe('')
    expect(image.width).toBe(34)
    expect(image.height).toBe(34)
    expect(tile.querySelector('svg')).toBeNull()
  })
})

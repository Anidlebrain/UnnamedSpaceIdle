import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { SmartSelect } from '../../src/renderer/SmartSelect'

describe('SmartSelect', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('centers a selected late Node and does not snap back when the user scrolls', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const list = document.querySelector<HTMLElement>('.smart-select-list')
      const index = this.dataset.value ? Number(this.dataset.value.slice(1)) - 1 : 0
      const top = this.dataset.value ? index * 32 - (list?.scrollTop ?? 0) : 0
      const height = this.classList.contains('smart-select-list') ? 280 : 32
      return { top, bottom: top + height, left: 0, right: 280, width: 280, height } as DOMRect
    })
    render(
      <SmartSelect
        label="节点"
        value="B30"
        searchable
        onChange={() => {}}
        options={Array.from({ length: 36 }, (_, index) => ({ value: `B${index + 1}`, label: `B${index + 1}` }))}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: '节点' }))
    const list = screen.getByRole('listbox', { name: '节点' })
    const scroll = list.scrollTop
    expect(scroll).toBeGreaterThan(0)
    expect(29 * 32 - scroll).toBeGreaterThan(100)
    expect(29 * 32 - scroll).toBeLessThan(180)
    expect(screen.getByRole('option', { name: 'B29' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'B31' })).toBeTruthy()
    list.scrollTop = scroll - 64
    fireEvent.scroll(list)
    expect(list.scrollTop).toBe(scroll - 64)
    list.scrollTop = scroll + 64
    fireEvent.scroll(list)
    expect(list.scrollTop).toBe(scroll + 64)
  })

  it('anchors a short upward-opening menu directly above its trigger', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('smart-select-trigger') ? 500 : 0
      const height = this.classList.contains('smart-select-trigger') ? 40 : 0
      return { top, bottom: top + height, left: 200, right: 480, width: 280, height } as DOMRect
    })
    render(
      <SmartSelect
        label="A3 舰种"
        value=""
        onChange={() => {}}
        options={['空位', '战斗机', '护卫舰', '驱逐舰', '巡洋舰', '重型巡洋舰'].map(label => ({
          value: label,
          label,
        }))}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'A3 舰种' }))
    const popover = document.querySelector<HTMLElement>('.smart-select-popover')!
    expect(popover.style.bottom).toBe('204px')
    expect(popover.style.top).toBe('')
  })

  it('caps the list height and keeps overflow scrollable', () => {
    const css = readFileSync('src/renderer/phase4.css', 'utf8')
    expect(css).toMatch(/\.smart-select-list\s*\{[^}]*max-height:\s*min\(17\.5rem,\s*45vh\)/)
    expect(css).toMatch(/\.smart-select-list\s*\{[^}]*overflow-y:\s*auto/)
    expect(css).toMatch(/\.best-formation \.formation-row\s*\{[^}]*display:\s*grid/)
  })
})

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/App'
import { createBrowserApi } from '../../src/renderer/web-runtime-api'
import { FLEET_MANAGER_BRIDGE_NAME } from '../../src/shared/bridge'

const LOCATION_KEY = 'fleet-manager-location-v1'
const navigate = (name: string) =>
  fireEvent.click(
    within(screen.getByRole('complementary', { name: '主工作区' })).getByRole('button', {
      name: accessibleName => accessibleName === name || accessibleName === name + ' •',
    }),
  )
async function openApp(api = createBrowserApi()) {
  window[FLEET_MANAGER_BRIDGE_NAME] = api
  render(<App />)
  return api
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('App Titan workspace integration', () => {
  it('opens Titan from the fleet navigation without fleet-specific selectors', async () => {
    await openApp()
    await screen.findByRole('heading', { name: '节点配置', level: 1 })
    navigate('泰坦搜索')
    await screen.findByRole('heading', { name: '泰坦搜索', level: 1 })
    await screen.findByRole('tab', { name: '玩家档案' })
    expect(screen.queryByRole('region', { name: '当前配置上下文' })).toBeNull()
    expect(screen.getByText('尚未录入玩家档案')).toBeDefined()
    expect(
      screen.getByText('Web 工作区可录入和保存档案。运行原生泰坦搜索、读取本机区域资料需要桌面应用。'),
    ).toBeDefined()
  })

  it('allows Titan setup before a fleet catalog has been imported', async () => {
    const api = createBrowserApi()
    vi.spyOn(api, 'catalog').mockResolvedValue({ galaxies: [], templates: [] })
    await openApp(api)
    await waitFor(() => expect(api.catalog).toHaveBeenCalled())
    await waitFor(() => expect(JSON.parse(localStorage.getItem(LOCATION_KEY) ?? 'null')?.contexts).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '打开泰坦搜索' }))
    await screen.findByRole('heading', { name: '泰坦搜索', level: 1 })
    await screen.findByRole('tab', { name: '玩家档案' })
    expect((screen.getByLabelText('统计总览 · 泰坦伤害') as HTMLInputElement).value).toBe('')
    navigate('节点配置')
    await screen.findByRole('button', { name: '扫描现有 map' })
  })

  it('restores Titan as the last location and returns to the saved fleet context', async () => {
    await openApp()
    await screen.findByRole('heading', { name: '节点配置', level: 1 })
    const original = JSON.parse(localStorage.getItem(LOCATION_KEY)!).contexts.node
    navigate('泰坦搜索')
    await screen.findByRole('heading', { name: '泰坦搜索', level: 1 })
    await waitFor(() => expect(JSON.parse(localStorage.getItem(LOCATION_KEY)!).workspace).toBe('titan'))
    const stored = JSON.parse(localStorage.getItem(LOCATION_KEY)!)
    expect(stored.contexts.node).toEqual(original)
    expect(stored.contexts).not.toHaveProperty('titan')
    cleanup()
    await openApp()
    await screen.findByRole('heading', { name: '泰坦搜索', level: 1 })
    navigate('节点配置')
    await screen.findByRole('heading', { name: '节点配置', level: 1 })
    fireEvent.click(screen.getByRole('tab', { name: '舰队状态' }))
    await screen.findByRole('spinbutton', { name: 'Fleet Resources' })
    expect(JSON.parse(localStorage.getItem(LOCATION_KEY)!).contexts.node).toEqual(original)
  })

  it('retains both fleet and Titan unsaved drafts while navigating between workspaces', async () => {
    const api = await openApp()
    const savePlayer = vi.spyOn(api.titan!, 'savePlayer')
    await screen.findByRole('heading', { name: '节点配置', level: 1 })
    fireEvent.click(screen.getByRole('tab', { name: '舰队状态' }))
    const resources = await screen.findByRole('spinbutton', { name: 'Fleet Resources' })
    fireEvent.change(resources, { target: { value: '777' } })
    navigate('泰坦搜索')
    await screen.findByRole('tab', { name: '玩家档案' })
    fireEvent.change(screen.getByLabelText('统计总览 · 泰坦伤害'), { target: { value: '9.75e25' } })
    navigate('节点配置')
    const restoredResources = await screen.findByRole('spinbutton', { name: 'Fleet Resources' })
    expect((restoredResources as HTMLInputElement).value).toBe('777')
    navigate('泰坦搜索')
    expect((screen.getByLabelText('统计总览 · 泰坦伤害') as HTMLInputElement).value).toBe('9.75e25')
    expect(savePlayer).not.toHaveBeenCalled()
    expect((await api.titan!.load()).player).toBeNull()
  })
})

it('keeps the uninitialized-fleet Titan draft when returning through the empty setup page', async () => {
  const api = createBrowserApi()
  vi.spyOn(api, 'catalog').mockResolvedValue({ galaxies: [], templates: [] })
  const savePlayer = vi.spyOn(api.titan!, 'savePlayer')
  await openApp(api)
  await waitFor(() => expect(JSON.parse(localStorage.getItem(LOCATION_KEY) ?? 'null')?.contexts).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: '打开泰坦搜索' }))
  await screen.findByRole('tab', { name: '玩家档案' })
  fireEvent.change(screen.getByLabelText('统计总览 · 泰坦伤害'), { target: { value: '6.75e24' } })
  navigate('节点配置')
  await screen.findByRole('button', { name: '扫描现有 map' })
  fireEvent.click(screen.getByRole('button', { name: '打开泰坦搜索' }))
  await screen.findByRole('tab', { name: '玩家档案' })
  expect((screen.getByLabelText('统计总览 · 泰坦伤害') as HTMLInputElement).value).toBe('6.75e24')
  expect(savePlayer).not.toHaveBeenCalled()
})

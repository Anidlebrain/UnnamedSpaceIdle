import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FLEET_MANAGER_BRIDGE_NAME } from '../../src/shared/bridge'
import type { NodeConfig } from '../../src/shared/schemas'
import { App } from '../../src/renderer/App'

const node: NodeConfig = {
  galaxy: 6,
  node: 'B1',
  hazards: [],
  supports: [],
  player_state: { fleet_resources: 1, ships: { Fighter: 1 } },
  baseline: {
    enabled: true,
    formation: { A1: 'Fighter' },
    loadouts: { Fighter: { primary: null, secondary: null, tertiary_mods: [] } },
  },
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step' as const,
    max_wall_seconds: 1,
    max_simulations: 1,
    workers: 1,
  },
}
const optimizerConfig = {
  objective: 'normal',
  mode: 'realistic',
  ship_types: ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'],
  group_ranges: {
    Fighter: { min: 0, max: 10 },
    Corvette: { min: 0, max: 10 },
    Frigate: { min: 0, max: 10 },
    Cruiser: { min: 0, max: 10 },
    HeavyCruiser: { min: 0, max: 10 },
  },
  allowed_mod_slots: {
    Fighter: { primary: [null, 'FighterMiniRailgunMod'], secondary: [null] },
    Corvette: { primary: [null, 'CorvetteChargeLaserMod'], secondary: [null, 'ShieldMod'] },
    Frigate: { primary: [null, 'FrigateMissileMod'], secondary: [null, 'ArmorMod'] },
    Cruiser: { primary: [null], secondary: [null, 'CruiserSingleArmorTank'] },
    HeavyCruiser: { primary: [null, 'HeavyCruiserBeamMod'], secondary: [null] },
  },
  max_total_groups: 10,
  max_groups_per_ship: { Fighter: 10, Corvette: 10, Frigate: 10, Cruiser: 10, HeavyCruiser: 10 },
  max_simulations: 1_000_000,
  max_wall_seconds: 300,
  top_n: 10,
  kill_refine_top_n: 3,
  kill_sequence_max_battles: 100,
}
const unsubscribe = vi.fn()
const unsubscribeProgress = vi.fn()
const galaxyResult = {
  galaxy: 'g6',
  status: 'completed' as const,
  total: 3,
  completed: 3,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:03.000Z',
  nodes: [
    { node: 'B1', version: 'default', common: 'default', status: 'succeeded' as const, changed: false },
    {
      node: 'B2',
      version: 'default',
      common: 'default',
      status: 'failed' as const,
      error: 'Optimizer exited with code 9.',
    },
    {
      node: 'B3',
      version: 'default',
      common: 'default',
      status: 'succeeded' as const,
      changed: true,
      run: {
        exitCode: 0,
        startedAt: '2026-01-01T00:00:02.000Z',
        finishedAt: '2026-01-01T00:00:03.000Z',
        result: {
          verified_baseline: { formation: [{ position: 'A1', ship: 'Fighter' }] },
          best_result: { formation: [{ position: 'A1', ship: 'Corvette' }] },
        },
      },
    },
  ],
}
const api = {
  catalog: vi.fn(async () => ({
    galaxies: [
      {
        id: 'g6',
        nodes: [{ id: 'B1', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] }],
        defaultCommon: 'default',
        commons: [{ id: 'default', name: '默认', isDefault: true }],
      },
    ],
    templates: [],
  })),
  load: vi.fn(async () => ({
    node,
    common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
  })),
  loadOptimizerConfig: vi.fn(async () => optimizerConfig),
  save: vi.fn(async () => {}),
  saveCommon: vi.fn(async () => {}),
  saveOptimizerConfig: vi.fn(async () => {}),
  createVersion: vi.fn(),
  renameVersion: vi.fn(),
  deleteVersion: vi.fn(),
  setDefaultVersion: vi.fn(),
  createCommon: vi.fn(),
  renameCommon: vi.fn(),
  deleteCommon: vi.fn(),
  setDefaultCommon: vi.fn(),
  createTemplate: vi.fn(),
  renameTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  createNode: vi.fn(),
  run: vi.fn(),
  rerunGalaxy: vi.fn(async () => galaxyResult),
  useBest: vi.fn(),
  previewImport: vi.fn(),
  importMap: vi.fn(),
  onOutput: vi.fn(() => unsubscribe),
  onGalaxyProgress: vi.fn(() => unsubscribeProgress),
}

describe('Renderer preload contract', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    window[FLEET_MANAGER_BRIDGE_NAME] = api
    vi.clearAllMocks()
  })
  it('mounts with the preload API, calls catalog, and renders the main UI', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    expect(api.catalog).toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '阵型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始搜索' })).toBeTruthy()
  })
  it('renders a clear startup error when the preload API is missing', () => {
    delete window[FLEET_MANAGER_BRIDGE_NAME]
    render(<App />)
    expect(screen.getByText('Fleet Manager 启动失败')).toBeTruthy()
    expect(screen.getByText('Preload API 未加载。请检查 Electron preload 配置。')).toBeTruthy()
  })
  it('registers and cleans up the output subscription', () => {
    const view = render(<App />)
    expect(api.onOutput).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribeProgress).toHaveBeenCalledTimes(1)
  })
  it('exposes Version and Common creation through their context menus', async () => {
    api.createVersion.mockResolvedValueOnce('qa-version')
    api.createCommon.mockResolvedValueOnce('qa-common')
    render(<App />)
    await screen.findByText('当前节点')

    fireEvent.click(screen.getByLabelText('管理版本'))
    fireEvent.click(screen.getByRole('button', { name: '新建版本' }))
    const versionName = await screen.findByRole('textbox', { name: '名称' })
    fireEvent.change(versionName, { target: { value: 'QA Version' } })
    fireEvent.click(screen.getByRole('button', { name: '创建版本' }))
    await waitFor(() =>
      expect(api.createVersion).toHaveBeenCalledWith(
        { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' },
        'QA Version',
      ),
    )

    fireEvent.click(screen.getByLabelText('管理公共配置'))
    fireEvent.click(screen.getByRole('button', { name: '新建配置' }))
    const commonName = await screen.findByRole('textbox', { name: '名称' })
    fireEvent.change(commonName, { target: { value: 'QA Common' } })
    fireEvent.click(screen.getByRole('button', { name: '创建配置' }))
    await waitFor(() =>
      expect(api.createCommon).toHaveBeenCalledWith(
        { galaxy: 'g6', node: 'B1', version: 'qa-version', common: 'default' },
        'QA Common',
      ),
    )
  })
  it('blocks dirty search and has no direct node APIs', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.change(screen.getByLabelText('Node JSON 编辑器'), { target: { value: '{}' } })
    expect((screen.getByRole('button', { name: '开始搜索' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('保存修改后即可搜索。')).toBeTruthy()
    const source = await import('node:fs/promises').then(x => x.readFile('src/renderer/App.tsx', 'utf8'))
    expect(source).not.toMatch(/from ['"]node:(fs|child_process)/)
  })
  it('runs only the selected Galaxy and emphasizes changed and failed nodes', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑 G6' }))
    await screen.findByText('需要重新配置的节点')
    expect(api.rerunGalaxy).toHaveBeenCalledWith('g6')
    expect(screen.getByText(/1 个节点配置不变，已从结果列表过滤/)).toBeTruthy()
    const changed = screen.getByRole('button', { name: /B3.*查看 Baseline/ })
    expect(changed).toBeTruthy()
    expect(screen.getByText('Optimizer exited with code 9.')).toBeTruthy()
    fireEvent.click(changed)
    await screen.findByText('当前配置')
    expect(api.load).toHaveBeenLastCalledWith({ galaxy: 'g6', node: 'B3', version: 'default', common: 'default' })
    expect(screen.getByText('最优配置')).toBeTruthy()
    expect(screen.getAllByText('护卫舰').length).toBeGreaterThan(0)
  })
  it('shows numeric Formation values and preserves numeric storage when edited', async () => {
    api.load.mockResolvedValueOnce({
      node: {
        ...node,
        player_state: { fleet_resources: 1, ships: { Fighter: 1, Frigate: 1, Cruiser: 1 } },
        baseline: {
          ...node.baseline,
          formation: { A1: 'Fighter', A2: 4 },
          loadouts: {
            ...node.baseline.loadouts,
            Frigate: { primary: null, secondary: null, tertiary_mods: [] },
            Cruiser: { primary: null, secondary: null, tertiary_mods: [] },
          },
        },
      },
      common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
    })
    render(<App />)
    const numericSlot = await screen.findByLabelText('A2 舰种')
    expect((numericSlot as HTMLSelectElement).value).toBe('Cruiser')
    expect(screen.getByText('巡洋舰（Cruiser · 4）')).toBeTruthy()
    fireEvent.change(numericSlot, { target: { value: 'Frigate' } })
    await waitFor(() =>
      expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toContain('"A2": 3'),
    )
  })
  it('renders one-Mod slots as toggles, multi-Mod slots as selects, and writes compatible values', async () => {
    api.loadOptimizerConfig.mockResolvedValueOnce({
      ...optimizerConfig,
      allowed_mod_slots: {
        ...optimizerConfig.allowed_mod_slots,
        Fighter: { primary: [null, 'FighterMiniRailgunMod', 'FighterAltMod'], secondary: [null] },
      },
    })
    api.load.mockResolvedValueOnce({
      node: {
        ...node,
        player_state: { fleet_resources: 1, ships: { Fighter: 1, Corvette: 1 } },
        baseline: {
          ...node.baseline,
          loadouts: {
            Fighter: { primary: null, secondary: null, tertiary_mods: [] },
            Corvette: { primary: null, secondary: 'ShieldMod', tertiary_mods: [] },
          },
        },
      },
      common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '装配' }))

    const secondaryToggle = (await screen.findByLabelText(/Corvette secondary.*护盾强化/)) as HTMLInputElement
    expect(secondaryToggle.type).toBe('checkbox')
    expect(secondaryToggle.checked).toBe(true)
    fireEvent.click(secondaryToggle)
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toContain('"secondary": null')

    const primarySelect = screen.getByLabelText('Fighter primary') as HTMLSelectElement
    expect(primarySelect.tagName).toBe('SELECT')
    fireEvent.change(primarySelect, { target: { value: 'FighterAltMod' } })
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toContain(
      '"primary": "FighterAltMod"',
    )
    expect(screen.getAllByText('自动 / 无手选槽位').length).toBeGreaterThan(0)
  })
})

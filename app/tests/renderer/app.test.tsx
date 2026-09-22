import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FLEET_MANAGER_BRIDGE_NAME } from '../../src/shared/bridge'
import type { NodeConfig } from '../../src/shared/schemas'
import type { SearchTaskSnapshot } from '../../src/shared/contracts'
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
const unsubscribeTask = vi.fn()
let taskListener: ((task: SearchTaskSnapshot) => void) | undefined
const searchTask = (nodeId = 'B1'): SearchTaskSnapshot => ({
  taskId: `task-${nodeId.toLowerCase()}`,
  galaxy: 'g6',
  node: nodeId,
  version: 'default',
  versionName: '默认',
  common: 'default',
  commonName: '默认',
  nodeConfigHash: 'node-hash',
  commonConfigHash: 'common-hash',
  optimizerConfigHash: 'optimizer-hash',
  optimizerConfigVersion: 'sha256:optimizer-hash',
  search: node.search,
  startedAt: '2026-01-01T00:00:00.000Z',
})
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
  saveSearch: vi.fn(async (_selection, search) => ({ ...node, search })),
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
  onSearchTask: vi.fn(listener => {
    taskListener = listener
    return unsubscribeTask
  }),
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
    taskListener = undefined
    localStorage.clear()
  })
  it('mounts with the preload API, calls catalog, and renders the main UI', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    expect(api.catalog).toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '阵型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
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
  it('keeps a Node draft when switching pages without blocking the Search domain', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.change(screen.getByLabelText('Node JSON 编辑器'), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect((screen.getByRole('button', { name: '开始搜索' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /节点配置/ }))
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toBe('{}')
    const source = await import('node:fs/promises').then(x => x.readFile('src/renderer/App.tsx', 'utf8'))
    expect(source).not.toMatch(/from ['"]node:(fs|child_process)/)
  })
  it('keeps a running task bound to its snapshot while unrelated Node editing remains available', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    act(() => taskListener?.(searchTask('B21')))
    await screen.findByText(/B21 搜索中/)
    fireEvent.change(screen.getByLabelText('Node JSON 编辑器'), {
      target: { value: JSON.stringify({ ...node, hazards: ['B10'] }, null, 2) },
    })
    expect((screen.getByRole('button', { name: '保存节点' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByText('准备搜索')).toBeTruthy()
    expect(screen.getByText('正在运行')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'B21 搜索中…' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('makes the active task Node, Common, and Optimizer Public explicitly read-only', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    act(() => taskListener?.(searchTask()))
    await screen.findByText(/该 Node Version正在被 B1 搜索任务使用/)
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).matches(':disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '公共配置' }))
    await screen.findByText(/该 Galaxy Common正在被 B1 搜索任务使用/)
    fireEvent.click(screen.getByRole('tab', { name: 'Optimizer 公共' }))
    await screen.findByText(/Optimizer 公共配置正在被 B1 搜索任务使用/)
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
    await screen.findByText('Best Found')
    expect(api.load).toHaveBeenLastCalledWith({ galaxy: 'g6', node: 'B3', version: 'default', common: 'default' })
    expect(screen.getByText('Best Found Formation')).toBeTruthy()
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
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '阵型' }))
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

  it('writes Fleet Resources and all supported ship counts through the structured Fleet State editor', async () => {
    api.load.mockResolvedValueOnce({
      node: {
        ...node,
        player_state: {
          fleet_resources: 50,
          ships: { Fighter: 1, Corvette: 2, Frigate: 3, Cruiser: 4, HeavyCruiser: 5 },
        },
      },
      common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '舰队状态' }))
    fireEvent.change(screen.getByLabelText('Fleet Resources'), { target: { value: '79.67' } })
    fireEvent.change(screen.getByLabelText('ships.HeavyCruiser'), { target: { value: '7' } })
    const raw = (screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value
    expect(raw).toContain('"fleet_resources": 79.67')
    expect(raw).toContain('"HeavyCruiser": 7')
  })

  it('edits Boss, Hazards, and Supports without Raw JSON', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '环境' }))
    await screen.findByText('战斗与环境')
    fireEvent.click(screen.getByText('Boss 存活'))
    fireEvent.change(screen.getByLabelText('Boss 剩余生命'), { target: { value: '3500' } })
    fireEvent.change(screen.getByLabelText('Boss 搜索优先级'), { target: { value: 'kill_cost' } })
    fireEvent.change(screen.getByLabelText('Hazards'), { target: { value: 'b10, b11' } })
    fireEvent.change(screen.getByLabelText('Supports'), { target: { value: 'f2\nF3' } })
    const raw = (screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value
    expect(raw).toContain('"alive": true')
    expect(raw).toContain('"remaining_hp": 3500')
    expect(raw).toContain('"priority": "kill_cost"')
    expect(raw).toContain('"B10"')
    expect(raw).toContain('"F3"')
  })

  it('keeps public configuration on its own page and does not mutate Node JSON', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    await waitFor(() => expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).not.toBe(''))
    const before = (screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value
    fireEvent.click(screen.getByRole('button', { name: '公共配置' }))
    expect(screen.getByRole('tab', { name: 'Galaxy 公共' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Optimizer 公共' }))
    expect(screen.getByText(/Node 搜索页覆盖 objective/)).toBeTruthy()
    expect(screen.getByText('全局 / 所有 Galaxy')).toBeTruthy()
    expect(screen.queryByLabelText('节点')).toBeNull()
    expect(screen.queryByLabelText('默认目标 objective')).toBeNull()
    fireEvent.change(screen.getByLabelText('舰队总组数上限'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '节点配置' }))
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toBe(before)
  })

  it('closes Version and Common menus on outside click, Escape, and page change', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    const versionMenu = screen.getByLabelText('管理版本')
    fireEvent.click(versionMenu)
    expect(screen.getByRole('button', { name: '新建版本' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('button', { name: '新建版本' })).toBeNull()

    fireEvent.click(versionMenu)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '新建版本' })).toBeNull()

    fireEvent.click(screen.getByLabelText('管理公共配置'))
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.queryByRole('button', { name: '新建配置' })).toBeNull()
  })

  it('shows the complete Best Found formation and ship-level loadout on the search page', async () => {
    const task = searchTask()
    api.run.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z',
      task,
      result: {
        verified_baseline: {
          formation: [{ position: 'A1', ship: 'Fighter' }],
          fleet_resources_committed: 100,
          fleet_resources_used: 90,
          outcome: 'victory',
        },
        best_result: {
          formation: [
            {
              position: 'A1',
              ship: 'Corvette',
              primary_mod: 'CorvetteChargeLaserMod',
              secondary_mod: 'ShieldMod',
              tertiary_mods: [],
            },
          ],
          ship_loadouts: {
            Corvette: { primary: 'CorvetteChargeLaserMod', secondary: 'ShieldMod', tertiary_mods: [] },
          },
          fleet_resources_committed: 92,
          fleet_resources_used: 80,
          boss_damage: 650,
          outcome: 'victory',
        },
        improvement_vs_baseline: { available: true, percent: 11.11 },
      },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '开始搜索' }))
    await screen.findByText('Best Found Formation')
    expect(JSON.parse(localStorage.getItem('fleet-manager-last-search-v1')!)).toMatchObject({
      galaxy: 'g6',
      node: 'B1',
    })
    expect(screen.getByText('Committed FR')).toBeTruthy()
    expect(screen.getByText('Used FR')).toBeTruthy()
    expect(screen.getByText('Boss Damage')).toBeTruthy()
    expect(screen.getByText('节省 FR')).toBeTruthy()
    expect(screen.getByText('A5')).toBeTruthy()
    expect(screen.getByText('B5')).toBeTruthy()
    expect(screen.getByText('Best Found Loadout')).toBeTruthy()
    expect(screen.getByText(/充能激光/)).toBeTruthy()
    expect(screen.getByText('应用到：G6 / B1 / 默认')).toBeTruthy()
    expect(screen.getByRole('button', { name: '使用最优配置' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /节点配置/ }))
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByText('Best Found Formation')).toBeTruthy()

    api.useBest.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: task.startedAt,
      finishedAt: task.startedAt,
      node: { ...node, baseline: { ...node.baseline, formation: { A1: 'Corvette' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: '使用最优配置' }))
    const confirmButtons = await screen.findAllByRole('button', { name: '使用最优配置' })
    fireEvent.click(confirmButtons.at(-1)!)
    await waitFor(() => expect(api.useBest).toHaveBeenCalledWith('task-b1'))
  })

  it('restores the last searched selection only inside the Search page context', async () => {
    const twoGalaxyCatalog = {
      galaxies: [
        {
          id: 'g5',
          nodes: [
            { id: 'B35', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
          ],
          defaultCommon: 'default',
          commons: [{ id: 'default', name: '默认', isDefault: true }],
        },
        {
          id: 'g6',
          nodes: [
            { id: 'B1', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
          ],
          defaultCommon: 'default',
          commons: [{ id: 'default', name: '默认', isDefault: true }],
        },
      ],
      templates: [],
    }
    localStorage.setItem(
      'fleet-manager-last-search-v1',
      JSON.stringify({ galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }),
    )
    api.catalog.mockResolvedValueOnce(twoGalaxyCatalog)
    render(<App />)
    await waitFor(() =>
      expect(api.load).toHaveBeenCalledWith({ galaxy: 'g5', node: 'B35', version: 'default', common: 'default' }),
    )
    expect((screen.getByLabelText('Galaxy') as HTMLSelectElement).value).toBe('g5')
    expect((screen.getByLabelText('节点') as HTMLSelectElement).value).toBe('B35')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect((screen.getByLabelText('Galaxy') as HTMLSelectElement).value).toBe('g6'))
    expect((screen.getByLabelText('节点') as HTMLSelectElement).value).toBe('B1')
  })
})

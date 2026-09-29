import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FLEET_MANAGER_BRIDGE_NAME } from '../../src/shared/bridge'
import type { NodeConfig } from '../../src/shared/schemas'
import { commonConfigSchema } from '../../src/shared/schemas'
import type { GalaxyRerunProgress, SearchQueueItem, SearchTaskSnapshot } from '../../src/shared/contracts'
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
let queueListener: ((queue: SearchQueueItem[]) => void) | undefined
let progressListener: ((progress: GalaxyRerunProgress) => void) | undefined
const searchTask = (nodeId = 'B1'): SearchTaskSnapshot => ({
  taskId: `task-${nodeId.toLowerCase()}`,
  galaxy: 'g6',
  node: nodeId,
  version: 'default',
  versionName: '默认',
  common: 'default',
  commonName: '默认',
  nodeConfigHash: 'node-hash',
  stagedNodeConfigHash: 'staged-node-hash',
  commonConfigHash: 'common-hash',
  optimizerConfigHash: 'optimizer-hash',
  optimizerConfigVersion: 'sha256:optimizer-hash',
  search: node.search,
  environment: { boss: node.boss, hazards: node.hazards, supports: node.supports },
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
    {
      node: 'B1',
      version: 'default',
      common: 'default',
      status: 'succeeded' as const,
      changed: false,
      run: {
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        task: searchTask(),
        result: {
          verified_baseline: { formation: [{ position: 'A1', ship: 'Fighter' }], fleet_resources_used: 15.89 },
          best_result: { formation: [{ position: 'A1', ship: 'Corvette' }], fleet_resources_used: 15.01 },
        },
      },
    },
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
        task: searchTask('B3'),
        result: {
          verified_baseline: { formation: [{ position: 'A1', ship: 'Fighter' }], fleet_resources_used: 15.01 },
          best_result: { formation: [{ position: 'A1', ship: 'Corvette' }], fleet_resources_used: 14.99 },
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
  loadSearchConfig: vi.fn(async () => node.search),
  configSources: vi.fn(async () => ({ search: 'default' as const, optimizer: 'default' as const })),
  save: vi.fn(async () => {}),
  saveSearchConfig: vi.fn(async search => search),
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
  createGalaxy: vi.fn(),
  run: vi.fn(),
  enqueueSearch: vi.fn(),
  searchQueue: vi.fn(async () => []),
  stopCurrent: vi.fn(async () => {}),
  stopAll: vi.fn(async () => {}),
  rerunGalaxy: vi.fn(async () => galaxyResult),
  useBest: vi.fn(),
  previewImport: vi.fn(),
  importMap: vi.fn(),
  onOutput: vi.fn(() => unsubscribe),
  onSearchTask: vi.fn(listener => {
    taskListener = listener
    return unsubscribeTask
  }),
  onSearchQueue: vi.fn(listener => {
    queueListener = listener
    return unsubscribe
  }),
  onGalaxyProgress: vi.fn(listener => {
    progressListener = listener
    return unsubscribeProgress
  }),
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
    queueListener = undefined
    progressListener = undefined
    localStorage.clear()
    api.searchQueue.mockResolvedValue([])
    api.enqueueSearch.mockImplementation(async request => {
      const run = await api.run(request)
      return { snapshot: run.task, status: run.error ? 'failed' : 'success', logs: '', run }
    })
  })
  it('mounts with the preload API, calls catalog, and renders the main UI', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    expect(api.catalog).toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '阵型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('button', { name: '加入搜索队列' })).toBeTruthy()
  })
  it('shows a third formation column and blocks shrinking while it contains a ship', async () => {
    api.load.mockResolvedValueOnce({
      node: {
        ...node,
        formation_columns: 3,
        baseline: { ...node.baseline, formation: { A1: 'Fighter', C5: 'Fighter' } },
      },
      common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
    })
    render(<App />)
    await screen.findByLabelText('C5 舰种')
    fireEvent.change(screen.getByLabelText('阵型列数'), { target: { value: '2' } })
    expect(screen.getByRole('alert').textContent).toContain('C5')
    expect((screen.getByLabelText('阵型列数') as HTMLSelectElement).value).toBe('3')
    expect(screen.getByLabelText('C5 舰种')).toBeTruthy()
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
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribeProgress).toHaveBeenCalledTimes(1)
  })
  it('exposes Version and Common creation through their context menus', async () => {
    api.createVersion.mockResolvedValueOnce('qa-version')
    api.createCommon.mockResolvedValueOnce('qa-common')
    render(<App />)
    await screen.findByText('当前节点')
    await waitFor(() => expect(screen.getByRole('combobox', { name: '版本' }).getAttribute('value')).toBe('default'))

    fireEvent.click(screen.getByLabelText('管理版本'))
    fireEvent.click(await screen.findByRole('button', { name: '新建版本' }))
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
    expect((screen.getByRole('button', { name: '加入搜索队列' }) as HTMLButtonElement).disabled).toBe(false)
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
    expect(screen.getByText('任务快照')).toBeTruthy()
    expect(screen.getAllByText('搜索中').length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: '加入搜索队列' }) as HTMLButtonElement).disabled).toBe(false)
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
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    await screen.findByText('发现变化的节点')
    expect(api.rerunGalaxy).toHaveBeenCalledWith(expect.objectContaining({ galaxy: 'g6', nodes: ['B1'] }))
    expect(screen.getByText(/1 个节点无有效变化，已从变化结果过滤/)).toBeTruthy()
    expect(within(screen.getByLabelText('节点重跑进度')).getByText('Used FR 取整：15 → 14（减少 1）')).toBeTruthy()
    const changed = screen.getByRole('button', { name: /B3.*查看 Best Found 结果/ })
    expect(changed).toBeTruthy()
    expect(screen.getAllByText(/未知运行错误/).length).toBeGreaterThan(0)
    fireEvent.click(changed)
    await screen.findByText('Best Found')
    expect(
      within(document.querySelector('.best-found') as HTMLElement).getByText(/Used FR 取整：15 → 14，减少 1/),
    ).toBeTruthy()
    expect(api.load).toHaveBeenLastCalledWith({ galaxy: 'g6', node: 'B3', version: 'default', common: 'default' })
    expect(screen.getByText('最终编队')).toBeTruthy()
    api.useBest.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:04.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      node,
    })
    fireEvent.click(screen.getByRole('button', { name: '使用最优配置' }))
    await waitFor(() => expect(api.useBest).toHaveBeenCalledWith('task-b3'))
    expect(((await screen.findByRole('button', { name: '已同步到配置' })) as HTMLButtonElement).disabled).toBe(true)
  })
  it('applies changed Galaxy results in one action and reports per-node failures', async () => {
    api.useBest.mockResolvedValueOnce({
      exitCode: -1,
      startedAt: '2026-01-01T00:00:04.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      error: '目标 Version 已变化',
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    const apply = await screen.findByRole('button', { name: '一键使用最优配置（1）' })
    fireEvent.click(apply)
    await waitFor(() => expect(api.useBest).toHaveBeenCalledExactlyOnceWith('task-b3'))
    expect(await screen.findByText('已应用 0 个节点的 Best Found；1 个未应用。')).toBeTruthy()
    expect((apply as HTMLButtonElement).disabled).toBe(false)
  })
  it('marks successfully applied Galaxy results and prevents a second write', async () => {
    api.useBest.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:04.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      node,
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    fireEvent.click(await screen.findByRole('button', { name: '一键使用最优配置（1）' }))
    expect(await screen.findByText('已应用 1 个节点的 Best Found；0 个未应用。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键使用最优配置（0）' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.useBest).toHaveBeenCalledExactlyOnceWith('task-b3')
  })
  it('creates a Galaxy from the current Common and Node source', async () => {
    api.createGalaxy.mockResolvedValueOnce({ node: 'B1', version: 'default', common: 'default' })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '模板与复制' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新 Galaxy ID' }), { target: { value: 'G7' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 Galaxy' }))
    await waitFor(() =>
      expect(api.createGalaxy).toHaveBeenCalledWith({
        galaxy: 'g7',
        node: 'B1',
        versionName: '默认',
        source: { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' },
      }),
    )
  })
  it('keeps finished rerun nodes inspectable and distinguishes changed, unchanged, and failed results', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    const grid = await screen.findByLabelText('节点重跑进度')
    expect(within(grid).getByRole('button', { name: /B3.*完成 · 有变化.*查看详情/ }).className).toContain('changed')
    expect(within(grid).getByRole('button', { name: /B1.*完成 · 无有效变化.*查看详情/ }).className).not.toContain(
      'changed',
    )
    expect(within(grid).getByText('Used FR 取整：15 → 15（变化 0）')).toBeTruthy()
    fireEvent.click(within(grid).getByRole('button', { name: /B1.*完成 · 无有效变化.*查看详情/ }))
    await screen.findByText('Best Found')
    expect(
      within(document.querySelector('.best-found') as HTMLElement).getByText(
        /Used FR 取整：15 → 15，变化 0。阵型或装配有 1 项差异/,
      ),
    ).toBeTruthy()
    expect((screen.getByRole('button', { name: '使用最优配置' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: /B2.*失败.*查看详情/ }))
    expect(await screen.findByText('Galaxy 重跑结果')).toBeTruthy()
    expect(screen.getByText('Optimizer exited with code 9.')).toBeTruthy()
    expect(screen.queryByText('Best Found')).toBeNull()
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
    const numericSlot = await screen.findByRole('combobox', { name: 'A2 舰种' })
    expect(numericSlot.textContent).toContain('巡洋舰')
    expect(screen.getByText('巡洋舰（Cruiser · 4）')).toBeTruthy()
    fireEvent.click(numericSlot)
    fireEvent.click(screen.getByRole('option', { name: '驱逐舰 · Frigate · 3' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toContain('"A2": 3'),
    )
  })
  it('adds an empty loadout when a ship enters the formation', async () => {
    api.load.mockResolvedValueOnce({
      node: {
        ...node,
        player_state: { fleet_resources: 1, ships: { Fighter: 1, Cruiser: 1 } },
        baseline: { ...node.baseline, formation: { A1: 1, A2: 0 } },
      },
      common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '阵型' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'A2 舰种' }))
    fireEvent.click(screen.getByRole('option', { name: '巡洋舰 · Cruiser · 4' }))
    await waitFor(() => {
      const raw = JSON.parse((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value)
      expect(raw.baseline.formation.A2).toBe(4)
      expect(raw.baseline.loadouts.Cruiser).toEqual({ primary: 0, secondary: 0 })
    })
  })
  it('renders one-Mod slots as toggles, multi-Mod slots as dropdowns, and writes compatible values', async () => {
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

    const primarySelect = screen.getByRole('combobox', { name: 'Fighter primary' })
    fireEvent.click(primarySelect)
    fireEvent.click(screen.getByRole('option', { name: /FighterAltMod/ }))
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

  it('accepts a typed minus sign before the ship count and shows the effective count', async () => {
    api.load.mockResolvedValueOnce({
      node: { ...node, player_state: { fleet_resources: 190, ships: { Fighter: 0, HeavyCruiser: 1 } } },
      common: commonConfigSchema.parse({
        permanent: { damage_scale: 1, health_scale: 1 },
        temporary: { damage_scale: 0, health_scale: 0 },
        ships: { Fighter: 1, Corvette: 2, HeavyCruiser: 0 },
      }),
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '舰队状态' }))
    expect(screen.getByText('公共 1 + 节点 0 = 搜索 1')).toBeTruthy()
    expect(screen.getByText('公共 0 + 节点 1 = 搜索 1')).toBeTruthy()
    const shipInput = screen.getByLabelText('ships.HeavyCruiser') as HTMLInputElement
    const user = userEvent.setup()
    await user.clear(shipInput)
    await user.type(shipInput, '-')
    expect(shipInput.value).toBe('-')
    expect(screen.getByText('公共 0 + 节点 1 = 搜索 1')).toBeTruthy()
    await user.type(shipInput, '2')
    expect(shipInput.value).toBe('-2')
    expect(screen.getByText('公共 0 + 节点 -2 = 搜索 0')).toBeTruthy()
    expect((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).toContain('"HeavyCruiser": -2')
  })

  it('edits Galaxy public ship counts through the structured Common editor', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '公共配置' }))
    fireEvent.change(screen.getByLabelText('common.ships.Fighter'), { target: { value: '2' } })
    expect((screen.getByLabelText('Common JSON 编辑器') as HTMLTextAreaElement).value).toContain('"Fighter": 2')
  })

  it('edits Boss, Hazards, and Supports without Raw JSON', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '环境' }))
    await screen.findByText('战斗与环境')
    fireEvent.click(screen.getByText('Boss 存活'))
    fireEvent.change(screen.getByLabelText('Boss 剩余生命'), { target: { value: '3500' } })
    fireEvent.click(screen.getByRole('combobox', { name: 'Boss 搜索优先级' }))
    fireEvent.click(screen.getByRole('option', { name: '击杀总成本（kill_cost）' }))
    fireEvent.change(screen.getByLabelText('Hazards'), { target: { value: 'b10, b11' } })
    fireEvent.change(screen.getByLabelText('Supports'), { target: { value: 'f2\nF3' } })
    const raw = (screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value
    expect(raw).toContain('"alive": true')
    expect(raw).toContain('"remaining_hp": 3500')
    expect(raw).toContain('"priority": "kill_cost"')
    expect(raw).toContain('"B10"')
    expect(raw).toContain('"F3"')
  })

  it('saves a decimal Used FR target on the Node instead of shared Search settings', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '环境' }))
    const target = screen.getByRole('textbox', { name: '普通战目标 Used FR（可选）' }) as HTMLInputElement
    await user.type(target, '27.3')
    expect(target.value).toBe('27.3')
    expect(
      JSON.parse((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).search.target_used_fr,
    ).toBe(27.3)
    await user.click(screen.getByRole('button', { name: '保存节点' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          search: expect.objectContaining({ target_used_fr: 27.3 }),
        }),
      ),
    )
    expect(api.saveSearchConfig).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Boss 存活'))
    expect(target.disabled).toBe(true)
    expect(
      JSON.parse((screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value).search.target_used_fr,
    ).toBeUndefined()
  })

  it('keeps commas and newlines editable while parsing environment nodes', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('tab', { name: '环境' }))
    const hazards = screen.getByLabelText('Hazards') as HTMLTextAreaElement
    const supports = screen.getByLabelText('Supports') as HTMLTextAreaElement

    fireEvent.change(hazards, { target: { value: 'B10,' } })
    expect(hazards.value).toBe('B10,')
    fireEvent.change(hazards, { target: { value: 'B10,\nB11' } })
    expect(hazards.value).toBe('B10,\nB11')
    fireEvent.change(supports, { target: { value: 'F2\n' } })
    expect(supports.value).toBe('F2\n')
    fireEvent.change(supports, { target: { value: 'F2\nF3' } })
    expect(supports.value).toBe('F2\nF3')

    const raw = (screen.getByLabelText('Node JSON 编辑器') as HTMLTextAreaElement).value
    expect(JSON.parse(raw).hazards).toEqual(['B10', 'B11'])
    expect(JSON.parse(raw).supports).toEqual(['F2', 'F3'])
    fireEvent.click(screen.getByRole('tab', { name: '阵型' }))
    fireEvent.click(screen.getByRole('tab', { name: '环境' }))
    expect((screen.getByLabelText('Hazards') as HTMLTextAreaElement).value).toBe('B10\nB11')
    expect((screen.getByLabelText('Supports') as HTMLTextAreaElement).value).toBe('F2\nF3')
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
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await screen.findByText('最终编队')
    expect(JSON.parse(localStorage.getItem('fleet-manager-last-search-v1')!)).toMatchObject({
      galaxy: 'g6',
      node: 'B1',
    })
    expect(screen.getByText('Committed FR')).toBeTruthy()
    expect(screen.getByText('Used FR')).toBeTruthy()
    expect(screen.getByText('Boss Damage')).toBeTruthy()
    expect(screen.getByText('Saved FR')).toBeTruthy()
    expect(screen.getByText('A5')).toBeTruthy()
    expect(screen.getByText('B5')).toBeTruthy()
    const formationTable = screen.getByRole('table', { name: /最终编队 B\/A/ })
    expect(
      within(formationTable)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['B', 'A'])
    const formationRows = within(formationTable).getAllByRole('row')
    expect(formationRows).toHaveLength(6)
    expect(
      within(formationRows[1])
        .getAllByRole('cell')
        .map(cell => cell.getAttribute('aria-label')),
    ).toEqual(['B1 空位', expect.stringMatching(/^A1 护卫舰/)])
    expect(
      within(formationRows[5])
        .getAllByRole('cell')
        .map(cell => cell.getAttribute('aria-label')),
    ).toEqual(['B5 空位', 'A5 空位'])
    expect(document.querySelectorAll('.best-loadouts > div')).toHaveLength(1)
    expect(screen.getByText('舰船最终配置')).toBeTruthy()
    expect(screen.getByText(/充能激光/)).toBeTruthy()
    expect(screen.getByText('应用到：G6 / B1 / 默认')).toBeTruthy()
    expect(screen.getByRole('button', { name: '使用最优配置' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /节点配置/ }))
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByText('最终编队')).toBeTruthy()

    api.useBest.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: task.startedAt,
      finishedAt: task.startedAt,
      node: { ...node, baseline: { ...node.baseline, formation: { A1: 'Corvette' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: '使用最优配置' }))
    await waitFor(() => expect(api.useBest).toHaveBeenCalledWith('task-b1'))
  })
  it('shows verified campaign damage and separate later formations when no affordable kill was found', async () => {
    api.run.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z',
      task: searchTask(),
      result: {
        current_fleet_resources: 100,
        affordable_kill_status: '未找到可负担的完整击杀',
        best_result: {
          formation: [{ position: 'A1', ship: 'Cruiser' }],
          fleet_resources_committed: 70,
          fleet_resources_used: 70,
          boss_damage: 65,
          outcome: 'lose',
          campaign_boss_damage: 95,
          campaign_battles: 2,
          campaign_remaining_fr: 0,
          refined_fr_spent: 100,
          boss_final_hp: 5,
          kill_sequence: [
            {
              battle: 1,
              boss_hp_before: 100,
              boss_hp_after: 35,
              boss_damage: 65,
              committed_fr: 70,
              used_fr: 70,
              fr_remaining: 30,
              formation: [{ position: 'A1', ship: 'Cruiser' }],
              loadouts: {},
            },
            {
              battle: 2,
              boss_hp_before: 35,
              boss_hp_after: 5,
              boss_damage: 30,
              committed_fr: 30,
              used_fr: 30,
              fr_remaining: 0,
              formation: [{ position: 'B5', ship: 'Fighter' }],
              loadouts: { Fighter: { primary: 'FighterMiniRailgunMod', secondary: null } },
            },
          ],
        },
      },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await screen.findByText('当前资源方案：2 场，累计伤害 95，剩余 BOSS 血量 5。')
    expect(screen.getByText('累计消耗 100 FR · 剩余资源 0 FR')).toBeTruthy()
    expect(screen.getByText('首场 Boss Damage')).toBeTruthy()
    expect(screen.queryByText('Saved FR')).toBeNull()
    const second = screen.getByText('第 2 场：BOSS 35 → 5 · 消耗 30 FR')
    fireEvent.click(second)
    expect(second.closest('details')?.open).toBe(true)
    expect(within(second.closest('details')!).getByText(/B5/)).toBeTruthy()
    expect(within(second.closest('details')!).getByText(/Primary/)).toBeTruthy()
    expect(screen.getByText(/对应第 1 场/)).toBeTruthy()
  })
  it('uses result grid width when showing a C-column Best Found', async () => {
    api.run.mockResolvedValueOnce({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z',
      task: searchTask(),
      result: {
        base_config: { grid_size: [3, 5] },
        verified_baseline: { formation: [{ position: 'A1', ship: 'Fighter' }] },
        best_result: { formation: [{ position: 'C5', ship: 'Fighter' }] },
      },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    const table = await screen.findByRole('table', { name: /最终编队 C\/B\/A/ })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['C', 'B', 'A'])
    expect(within(table).getByRole('cell', { name: /C5 战斗机/ })).toBeTruthy()
  })

  it('starts directly with the edited 200/200 Search draft without a separate save action', async () => {
    api.run.mockImplementationOnce(async request => ({
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      task: { ...searchTask(), search: request.search },
    }))
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索设置' }))
    fireEvent.change(screen.getByLabelText('最多模拟（次）'), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('最长时间（秒）'), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('button', { name: '保存搜索参数' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await waitFor(() =>
      expect(api.enqueueSearch).toHaveBeenCalledWith(
        expect.objectContaining({ search: expect.objectContaining({ max_simulations: 200, max_wall_seconds: 200 }) }),
      ),
    )
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
  it('restores the last active page and its selection after remount', async () => {
    const selected = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    localStorage.setItem(
      'fleet-manager-location-v1',
      JSON.stringify({
        workspace: 'search',
        contexts: {
          node: selected,
          search: selected,
          common: selected,
          templates: selected,
          rerunGalaxy: 'g6',
        },
      }),
    )
    const view = render(<App />)
    await screen.findByRole('button', { name: '加入搜索队列' })
    expect((screen.getByLabelText('节点') as HTMLSelectElement).value).toBe('B1')
    view.unmount()
    render(<App />)
    await screen.findByRole('button', { name: '加入搜索队列' })
    expect(screen.getByRole('heading', { name: '搜索', level: 1 })).toBeTruthy()
  })
  it('blocks the same Node and Version while its task is running', async () => {
    api.enqueueSearch.mockResolvedValueOnce({ snapshot: searchTask('B1'), status: 'waiting', logs: '' })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await waitFor(() => expect(api.enqueueSearch).toHaveBeenCalledTimes(1))
    act(() => queueListener?.([{ snapshot: searchTask('B1'), status: 'running', logs: 'searching' }]))
    expect((screen.getByRole('button', { name: '加入搜索队列' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    expect(api.enqueueSearch).toHaveBeenCalledTimes(1)
  })
  it('removes completed and failed task reminders after their results are viewed', async () => {
    render(<App />)
    await screen.findByText('当前节点')
    const finishedAt = '2026-01-01T00:00:04.000Z'
    const items: SearchQueueItem[] = [
      {
        snapshot: searchTask('B1'),
        status: 'success',
        logs: '',
        run: { exitCode: 0, startedAt: searchTask().startedAt, finishedAt },
      },
      {
        snapshot: searchTask('B2'),
        status: 'failed',
        logs: '',
        run: { exitCode: 1, startedAt: searchTask().startedAt, finishedAt, error: 'failed' },
      },
    ]
    act(() => queueListener?.(items))
    const queue = screen.getByLabelText('搜索任务队列')
    expect(within(queue).getAllByRole('button')).toHaveLength(2)
    fireEvent.click(within(queue).getByRole('button', { name: /B1/ }))
    expect(within(screen.getByLabelText('搜索任务队列')).queryByRole('button', { name: /B1/ })).toBeNull()
    expect(within(screen.getByLabelText('搜索任务队列')).getByRole('button', { name: /B2/ })).toBeTruthy()
    fireEvent.click(within(screen.getByLabelText('搜索任务队列')).getByRole('button', { name: /B2/ }))
    expect(screen.queryByLabelText('搜索任务队列')).toBeNull()
  })
  it('keeps Galaxy rerun selection and requested order with the compact node grid', async () => {
    api.catalog.mockResolvedValueOnce({
      galaxies: [
        {
          id: 'g6',
          nodes: ['B1', 'B2', 'B3'].map(id => ({
            id,
            defaultVersion: 'default',
            versions: [{ id: 'default', name: '默认', isDefault: true }],
          })),
          defaultCommon: 'default',
          commons: [{ id: 'default', name: '默认', isDefault: true }],
        },
      ],
      templates: [],
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    expect(document.querySelector('.rerun-workspace.configuring')).toBeTruthy()
    expect(document.querySelector('.rerun-empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全取消' }))
    expect(screen.getAllByRole('checkbox').every(checkbox => !(checkbox as HTMLInputElement).checked)).toBe(true)
    expect((screen.getByRole('button', { name: '开始重跑所选节点' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getAllByRole('checkbox').every(checkbox => (checkbox as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /B2/ }))
    fireEvent.click(screen.getByRole('button', { name: '下移 B1' }))
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getByRole('checkbox', { name: /3 B2/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /B2/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    await waitFor(() => expect(api.rerunGalaxy).toHaveBeenCalledWith(expect.objectContaining({ nodes: ['B3', 'B1'] })))
    expect(document.querySelector('.rerun-workspace.has-results')).toBeTruthy()
    expect(document.querySelector('.rerun-selection-details:not([open])')).toBeTruthy()
    expect(screen.getByLabelText('Galaxy 全局重跑')).toBeTruthy()
    fireEvent.click(screen.getByText('调整下次重跑'))
    expect(screen.getByRole('button', { name: '全选' })).toBeTruthy()
  })
  it('restores rerun checkboxes across pages and restart, and checks newly added nodes', async () => {
    const catalogWith = (ids: string[]) => ({
      galaxies: [
        {
          id: 'g6',
          nodes: ids.map(id => ({
            id,
            defaultVersion: 'default',
            versions: [{ id: 'default', name: '默认', isDefault: true }],
          })),
          defaultCommon: 'default',
          commons: [{ id: 'default', name: '默认', isDefault: true }],
        },
      ],
      templates: [],
    })
    api.catalog.mockResolvedValueOnce(catalogWith(['B1', 'B2']))
    const first = render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /B2/ }))
    expect((screen.getByRole('checkbox', { name: /B2/ }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    expect((screen.getByRole('checkbox', { name: /B2/ }) as HTMLInputElement).checked).toBe(false)

    first.unmount()
    api.catalog.mockResolvedValueOnce(catalogWith(['B1', 'B2', 'B3']))
    render(<App />)
    await screen.findByRole('checkbox', { name: /B3/ })
    expect((screen.getByRole('checkbox', { name: /B1/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /B2/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /B3/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('已选 2 / 3 个节点')).toBeTruthy()
  })
  it('gives a running Galaxy rerun the full results area and keeps both stop actions available', async () => {
    let finish!: (result: typeof galaxyResult) => void
    api.rerunGalaxy.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy 重跑' }))
    fireEvent.click(screen.getByRole('button', { name: '开始重跑所选节点' }))
    const runningProgress: GalaxyRerunProgress = {
      galaxy: 'g6',
      status: 'running',
      total: 4,
      completed: 2,
      startedAt: '2026-01-01T00:00:00.000Z',
      currentNode: 'B1',
      nodes: [
        { node: 'B1', version: 'default', common: 'default', status: 'running' },
        { node: 'B2', version: 'default', common: 'default', status: 'queued' },
        { node: 'B3', version: 'default', common: 'default', status: 'succeeded', changed: true },
        { node: 'B4', version: 'default', common: 'default', status: 'failed', error: 'Optimizer exited with code 9.' },
      ],
    }
    act(() => progressListener?.(runningProgress))
    expect(document.querySelector('.rerun-workspace.has-results')).toBeTruthy()
    expect(document.querySelector('.rerun-selection-details:not([open])')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Galaxy' }) as HTMLButtonElement).disabled).toBe(true)
    const results = screen.getByLabelText('Galaxy 全局重跑')
    const nodeGrid = results.querySelector('.rerun-nodes') as HTMLElement
    expect(within(nodeGrid).getByText('B2')).toBeTruthy()
    expect(within(nodeGrid).getByText('B3')).toBeTruthy()
    expect(within(nodeGrid).getByText('B4')).toBeTruthy()
    expect(within(nodeGrid).getByText('✓ 完成 · 有变化')).toBeTruthy()
    expect(within(nodeGrid).queryByRole('button', { name: /B1.*查看详情/ })).toBeNull()
    expect(within(nodeGrid).queryByRole('button', { name: /B2.*查看详情/ })).toBeNull()
    expect(within(nodeGrid).getByRole('button', { name: /B4.*失败.*查看详情/ })).toBeTruthy()
    fireEvent.click(within(results).getByRole('button', { name: '停止当前节点' }))
    fireEvent.click(within(results).getByRole('button', { name: '停止整个批次' }))
    expect(api.stopCurrent).toHaveBeenCalledTimes(1)
    expect(api.stopAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('查看本次节点顺序'))
    act(() => progressListener?.({ ...runningProgress, completed: 0 }))
    expect((document.querySelector('.rerun-selection-details') as HTMLDetailsElement).open).toBe(true)
    expect((screen.getByRole('checkbox', { name: /B1/ }) as HTMLInputElement).disabled).toBe(true)
    await act(async () => finish(galaxyResult))
  })
  it('edits common and advanced Search fields without changing their persisted keys', async () => {
    api.enqueueSearch.mockImplementationOnce(async request => ({
      snapshot: { ...searchTask(), search: request.search },
      status: 'waiting',
      logs: '',
    }))
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索设置' }))
    fireEvent.click(screen.getByRole('combobox', { name: '搜索方式' }))
    fireEvent.click(screen.getByRole('option', { name: '扩大探索' }))
    fireEvent.click(screen.getByText('高级设置'))
    fireEvent.change(screen.getByLabelText('并行进程'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('combobox', { name: '模拟时钟' }))
    fireEvent.click(screen.getByRole('option', { name: '实时同步（对照 / 调试）' }))
    fireEvent.click(screen.getByRole('combobox', { name: '优化目标' }))
    fireEvent.click(screen.getByRole('option', { name: '寻找最佳方案' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await waitFor(() =>
      expect(api.enqueueSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({
            profile: 'balanced',
            goal: 'best',
            simulation_clock: 'realtime',
            workers: 3,
            max_wall_seconds: 1,
            max_simulations: 1,
          }),
        }),
      ),
    )
  })
  it('selects advisor position search and sends the strategy through the queue request', async () => {
    api.enqueueSearch.mockImplementationOnce(async request => ({
      snapshot: { ...searchTask(), search: request.search },
      status: 'waiting',
      logs: '',
    }))
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索设置' }))
    fireEvent.click(screen.getByRole('combobox', { name: '搜索策略' }))
    fireEvent.click(screen.getByRole('option', { name: '推荐舰队搜站位' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(screen.getByText(/起始站位允许战败/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await waitFor(() =>
      expect(api.enqueueSearch).toHaveBeenCalledWith(
        expect.objectContaining({ search: expect.objectContaining({ strategy: 'advisor_seeded' }) }),
      ),
    )
  })
  it('shows a concise error and keeps raw details collapsed', async () => {
    const raw = 'BASELINE VALIDATION FAILED ' + JSON.stringify({ formation: Array(100).fill('bad') })
    api.enqueueSearch.mockResolvedValueOnce({
      snapshot: searchTask(),
      status: 'failed',
      logs: raw,
      run: { exitCode: 1, startedAt: searchTask().startedAt, finishedAt: searchTask().startedAt, error: raw },
    })
    render(<App />)
    await screen.findByText('当前节点')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '加入搜索队列' }))
    await screen.findByText('基线配置无效')
    const details = screen.getByText('查看详情').closest('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('BASELINE VALIDATION FAILED')
  })
})

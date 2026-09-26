import type {
  Catalog,
  FleetManagerApi,
  GalaxyRerunProgress,
  NamedItem,
  OptimizerOutput,
  RunResult,
  SearchQueueItem,
  SearchTaskSnapshot,
  Selection,
} from '../shared/contracts'
import type { CommonConfig, NodeConfig, OptimizerConfig, SearchConfig } from '../shared/schemas'
import { nodeConfigSchema, optimizerConfigSchema } from '../shared/schemas'
import { effectiveShipCounts } from '../shared/ship-counts'
import { hasRerunChange } from '../shared/formation-diff'
import { formationColumns, formationResultError } from '../shared/formation-grid'
import { preserveShipSelectorFormat, shipSelectorToId } from '../shared/ship-selectors'

const clone = <T>(value: T): T => structuredClone(value)
const STORAGE_KEY = 'fleet-manager-web-workspace-v1'

const shipLoadouts = {
  Fighter: { primary: null, secondary: null, tertiary_mods: [] },
  Corvette: { primary: 'CorvetteChargeLaserMod', secondary: 'ShieldMod', tertiary_mods: [] },
  Frigate: { primary: null, secondary: 'ArmorMod', tertiary_mods: [] },
  Cruiser: { primary: null, secondary: 'CruiserSingleArmorTank', tertiary_mods: [] },
  HeavyCruiser: { primary: null, secondary: null, tertiary_mods: [] },
}

const makeNode = (galaxy: number, node: string, numeric = false): NodeConfig => ({
  galaxy,
  node,
  boss: { alive: false, remaining_hp: 0, priority: 'efficiency' },
  hazards: node === 'B13' ? ['B16'] : [],
  supports: node === 'B12' ? ['F3'] : [],
  player_state: {
    fleet_resources: galaxy === 6 ? 120 : 96,
    ships: { Fighter: 1, Corvette: 2, Frigate: 1, Cruiser: 2, HeavyCruiser: 0 },
  },
  baseline: {
    enabled: true,
    formation: numeric
      ? { A1: 2, A2: 4, A4: 5, B1: 2, B3: 1 }
      : { A1: 'Corvette', A2: 'Cruiser', A4: 'HeavyCruiser', B1: 'Corvette', B3: 'Fighter' },
    loadouts: clone(shipLoadouts),
  },
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step',
    max_wall_seconds: 300,
    max_simulations: 300,
    workers: 4,
  },
})

const defaultCommon: CommonConfig = {
  permanent: { damage_scale: 3.25, health_scale: 3.25 },
  temporary: { damage_scale: 0, health_scale: 0 },
}

let optimizerConfig: OptimizerConfig = {
  objective: 'normal',
  mode: 'realistic',
  ship_types: ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'],
  group_ranges: Object.fromEntries(
    ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'].map(ship => [ship, { min: 0, max: 15 }]),
  ),
  allowed_mod_slots: {
    Fighter: { primary: [null, 'FighterMiniRailgunMod'], secondary: [null] },
    Corvette: { primary: [null, 'CorvetteChargeLaserMod'], secondary: [null, 'ShieldMod'] },
    Frigate: { primary: [null, 'FrigateMissileMod'], secondary: [null, 'ArmorMod'] },
    Cruiser: { primary: [null], secondary: [null, 'CruiserSingleArmorTank'] },
    HeavyCruiser: { primary: [null, 'HeavyCruiserBeamMod'], secondary: [null] },
  },
  max_total_groups: 15,
  max_groups_per_ship: Object.fromEntries(
    ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'].map(ship => [ship, 15]),
  ),
  max_simulations: 1_000_000,
  max_wall_seconds: 300,
  top_n: 10,
  kill_refine_top_n: 3,
  kill_sequence_max_battles: 100,
}
let searchConfig: SearchConfig = {
  profile: 'fast',
  goal: 'beat_baseline',
  simulation_clock: 'offline_fixed_step',
  max_wall_seconds: 300,
  max_simulations: 300,
  workers: 4,
}

const catalog: Catalog = {
  galaxies: [
    {
      id: 'g5',
      nodes: [
        {
          id: 'B35',
          defaultVersion: 'default',
          versions: [{ id: 'default', name: '日常配置', isDefault: true }],
        },
      ],
      defaultCommon: 'default',
      commons: [{ id: 'default', name: '常规加成', isDefault: true }],
    },
    {
      id: 'g6',
      nodes: [
        {
          id: 'B12',
          defaultVersion: 'default',
          versions: [
            { id: 'default', name: '日常配置', isDefault: true },
            { id: 'numeric-history', name: '历史数字阵型', isDefault: false },
          ],
        },
        {
          id: 'B13',
          defaultVersion: 'default',
          versions: [{ id: 'default', name: 'Boss 前置', isDefault: true }],
        },
      ],
      defaultCommon: 'default',
      commons: [
        { id: 'default', name: '常规加成', isDefault: true },
        { id: 'burst', name: '临时爆发', isDefault: false },
      ],
    },
  ],
  templates: [{ id: 'stable-boss', name: '稳定 Boss 模板' }],
}

const nodes = new Map<string, NodeConfig>([
  ['g5/B35/default', makeNode(5, 'B35')],
  ['g6/B12/default', makeNode(6, 'B12')],
  ['g6/B12/numeric-history', makeNode(6, 'B12', true)],
  ['g6/B13/default', makeNode(6, 'B13')],
])
const commons = new Map<string, CommonConfig>([
  ['g5/default', clone(defaultCommon)],
  ['g6/default', clone(defaultCommon)],
  [
    'g6/burst',
    { permanent: { damage_scale: 3.25, health_scale: 3.25 }, temporary: { damage_scale: 1.4, health_scale: 1 } },
  ],
])

type BrowserWorkspaceSnapshot = {
  catalog: Catalog
  nodes: [string, NodeConfig][]
  commons: [string, CommonConfig][]
  optimizerConfig?: OptimizerConfig
  searchConfig?: SearchConfig
}

function restoreWorkspace() {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const snapshot = JSON.parse(raw) as BrowserWorkspaceSnapshot
    catalog.galaxies = snapshot.catalog.galaxies
    catalog.templates = snapshot.catalog.templates
    nodes.clear()
    commons.clear()
    for (const [entryKey, node] of snapshot.nodes) nodes.set(entryKey, node)
    for (const [entryKey, common] of snapshot.commons) commons.set(entryKey, common)
    if (snapshot.optimizerConfig) optimizerConfig = snapshot.optimizerConfig
    if (snapshot.searchConfig) searchConfig = snapshot.searchConfig
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }
}

function persistWorkspace() {
  if (typeof localStorage === 'undefined') return
  const snapshot: BrowserWorkspaceSnapshot = {
    catalog,
    nodes: [...nodes.entries()],
    commons: [...commons.entries()],
    optimizerConfig,
    searchConfig,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

restoreWorkspace()

const key = ({ galaxy, node, version }: Selection) => `${galaxy}/${node}/${version}`
const commonKey = ({ galaxy, common }: Selection) => `${galaxy}/${common}`
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}`
const hash = (value: unknown) => {
  const source = JSON.stringify(value)
  let result = 2166136261
  for (let index = 0; index < source.length; index++) result = Math.imul(result ^ source.charCodeAt(index), 16777619)
  return `web-${(result >>> 0).toString(16).padStart(8, '0')}`
}

function setDefault(items: NamedItem[], id: string) {
  for (const item of items) item.isDefault = item.id === id
}

function sampleRun(selection: Selection, task?: SearchTaskSnapshot): RunResult {
  const current = nodes.get(key(selection))!
  const formation = Object.entries(current.baseline.formation)
    .filter(([, ship]) => ship !== 0 && ship !== null && ship !== '')
    .map(([position, ship]) => {
      const shipId = shipSelectorToId(ship) || String(ship)
      const loadout = current.baseline.loadouts[shipId] ?? {}
      return {
        position,
        ship: String(ship),
        primary_mod: typeof loadout.primary === 'string' ? loadout.primary : null,
        secondary_mod: typeof loadout.secondary === 'string' ? loadout.secondary : null,
        tertiary_mods: loadout.tertiary_mods ?? [],
      }
    })
  const best = formation.map(entry => ({ ...entry }))
  if (best[0]) best[0].ship = best[0].ship === '2' || best[0].ship === 'Corvette' ? 'Cruiser' : 'Corvette'
  const now = new Date().toISOString()
  return {
    exitCode: 0,
    startedAt: now,
    finishedAt: now,
    task,
    result: {
      verified_baseline: {
        formation,
        ship_loadouts: clone(current.baseline.loadouts),
        fleet_resources_committed: 96,
        fleet_resources_used: 88.4,
        outcome: 'victory',
      },
      best_result: {
        formation: best,
        ship_loadouts: clone(current.baseline.loadouts),
        fleet_resources_committed: 92,
        fleet_resources_used: 82.7,
        outcome: 'victory',
      },
      improvement_vs_baseline: { available: true, fleet_resources_saved_per_battle: 5.7, percent: 6.45 },
      objective: 'efficiency',
      recommendation_status: 'improved',
    },
  }
}

export function createBrowserApi(): FleetManagerApi {
  const outputListeners = new Set<(output: OptimizerOutput) => void>()
  const taskListeners = new Set<(task: SearchTaskSnapshot) => void>()
  const progressListeners = new Set<(progress: GalaxyRerunProgress) => void>()
  const queueListeners = new Set<(queue: SearchQueueItem[]) => void>()
  const queue: SearchQueueItem[] = []
  let webQueueRunning = false
  let webStopCurrent = false
  const publishQueue = () => queueListeners.forEach(listener => listener(clone(queue)))
  const drainQueue = async () => {
    if (webQueueRunning) return
    webQueueRunning = true
    while (queue.some(item => item.status === 'waiting')) {
      const item = queue.find(entry => entry.status === 'waiting')!
      item.status = 'running'
      item.runningAt = new Date().toISOString()
      webStopCurrent = false
      publishQueue()
      const run = await api.run(item.snapshot)
      run.task!.taskId = item.snapshot.taskId
      if (lastSearch?.task) lastSearch.task.taskId = item.snapshot.taskId
      item.snapshot = run.task!
      item.run = run
      item.status = webStopCurrent ? 'canceled' : run.error ? 'failed' : 'success'
      publishQueue()
    }
    webQueueRunning = false
  }
  let lastSearch: RunResult | undefined
  const completedRuns = new Map<string, RunResult>()
  const latestResultByNode = new Map<string, string>()
  const api: FleetManagerApi = {
    runtime: 'web',
    previewImport: async () => ({ galaxies: [] }),
    importMap: async () => undefined,
    catalog: async () => clone(catalog),
    load: async selection => ({
      node: nodeConfigSchema.parse(
        clone(nodes.get(key(selection)) ?? makeNode(Number(selection.galaxy.slice(1)), selection.node)),
      ),
      common: clone(commons.get(commonKey(selection)) ?? defaultCommon),
    }),
    loadOptimizerConfig: async () => optimizerConfigSchema.parse(clone(optimizerConfig)),
    loadSearchConfig: async () => clone(searchConfig),
    configSources: async () => ({ search: 'local', optimizer: 'local' }),
    save: async (selection, node) => {
      nodes.set(key(selection), nodeConfigSchema.parse(clone(node)))
      persistWorkspace()
    },
    saveSearchConfig: async search => {
      searchConfig = clone(search)
      persistWorkspace()
      return clone(searchConfig)
    },
    saveCommon: async (selection, common) => {
      commons.set(commonKey(selection), clone(common))
      persistWorkspace()
    },
    saveOptimizerConfig: async config => {
      optimizerConfig = optimizerConfigSchema.parse(clone(config))
      persistWorkspace()
    },
    createVersion: async (selection, name) => {
      const id = uid('version')
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!.nodes.find(n => n.id === selection.node)!
      target.versions.push({ id, name, isDefault: false })
      nodes.set(`${selection.galaxy}/${selection.node}/${id}`, clone(nodes.get(key(selection))!))
      persistWorkspace()
      return id
    },
    renameVersion: async (selection, name) => {
      const item = catalog.galaxies
        .find(g => g.id === selection.galaxy)!
        .nodes.find(n => n.id === selection.node)!
        .versions.find(v => v.id === selection.version)!
      item.name = name
      persistWorkspace()
    },
    deleteVersion: async selection => {
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!.nodes.find(n => n.id === selection.node)!
      target.versions = target.versions.filter(v => v.id !== selection.version)
      nodes.delete(key(selection))
      persistWorkspace()
    },
    setDefaultVersion: async selection => {
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!.nodes.find(n => n.id === selection.node)!
      target.defaultVersion = selection.version
      setDefault(target.versions, selection.version)
      persistWorkspace()
    },
    createCommon: async (selection, name) => {
      const id = uid('common')
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!
      target.commons.push({ id, name, isDefault: false })
      commons.set(`${selection.galaxy}/${id}`, clone(commons.get(commonKey(selection))!))
      persistWorkspace()
      return id
    },
    renameCommon: async (selection, name) => {
      catalog.galaxies.find(g => g.id === selection.galaxy)!.commons.find(c => c.id === selection.common)!.name = name
      persistWorkspace()
    },
    deleteCommon: async selection => {
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!
      target.commons = target.commons.filter(c => c.id !== selection.common)
      commons.delete(commonKey(selection))
      persistWorkspace()
    },
    setDefaultCommon: async selection => {
      const target = catalog.galaxies.find(g => g.id === selection.galaxy)!
      target.defaultCommon = selection.common
      setDefault(target.commons, selection.common)
      persistWorkspace()
    },
    createTemplate: async (_selection, name) => {
      const id = uid('template')
      catalog.templates.push({ id, name })
      persistWorkspace()
      return id
    },
    renameTemplate: async (id, name) => {
      catalog.templates.find(item => item.id === id)!.name = name
      persistWorkspace()
    },
    deleteTemplate: async id => {
      catalog.templates = catalog.templates.filter(item => item.id !== id)
      persistWorkspace()
    },
    createNode: async request => {
      const galaxy = catalog.galaxies.find(g => g.id === request.galaxy)!
      const version = uid('version')
      galaxy.nodes.push({
        id: request.node,
        defaultVersion: version,
        versions: [{ id: version, name: request.versionName, isDefault: true }],
      })
      const source =
        request.source.type === 'selection' ? nodes.get(key(request.source.selection)) : nodes.values().next().value
      const next = clone(source ?? makeNode(Number(request.galaxy.slice(1)), request.node))
      next.galaxy = Number(request.galaxy.slice(1))
      next.node = request.node
      nodes.set(`${request.galaxy}/${request.node}/${version}`, next)
      persistWorkspace()
      return { node: request.node, version }
    },
    run: async request => {
      const selection: Selection = request
      const current = clone(nodes.get(key(selection))!)
      searchConfig = clone(request.search)
      persistWorkspace()
      const staged = { ...current, search: clone(searchConfig) }
      const common = clone(commons.get(commonKey(selection))!)
      const task: SearchTaskSnapshot = {
        ...request,
        formation_columns: current.formation_columns,
        search: clone(searchConfig),
        taskId: 'taskId' in request && typeof request.taskId === 'string' ? request.taskId : uid('task'),
        nodeConfigHash: hash(current),
        stagedNodeConfigHash: hash(staged),
        commonConfigHash: hash(common),
        optimizerConfigHash: hash(optimizerConfig),
        optimizerConfigVersion: `sha256:${hash(optimizerConfig)}`,
        environment: {
          boss: clone(staged.boss),
          hazards: clone(staged.hazards),
          supports: clone(staged.supports),
          player_state: { ...clone(staged.player_state), ships: effectiveShipCounts(staged, common) },
        },
        startedAt: new Date().toISOString(),
      }
      taskListeners.forEach(listener => listener(clone(task)))
      outputListeners.forEach(listener =>
        listener({ taskId: task.taskId, line: '读取配置…\n搜索候选阵型…\n验证 Best Found…\n完成。\n' }),
      )
      lastSearch = sampleRun(selection, task)
      const priorResult = latestResultByNode.get(key(selection))
      if (priorResult) completedRuns.delete(priorResult)
      completedRuns.set(task.taskId, lastSearch)
      latestResultByNode.set(key(selection), task.taskId)
      return clone(lastSearch)
    },
    enqueueSearch: async request => {
      const sameTarget = (item: SearchQueueItem) =>
        item.snapshot.galaxy === request.galaxy &&
        item.snapshot.node === request.node &&
        item.snapshot.version === request.version
      if (queue.some(item => sameTarget(item) && ['waiting', 'running'].includes(item.status)))
        throw new Error('该 Node / Version 已在等待或搜索中。')
      for (let index = queue.length - 1; index >= 0; index--) if (sameTarget(queue[index])) queue.splice(index, 1)
      const item: SearchQueueItem = {
        snapshot: {
          ...request,
          taskId: uid('task'),
          nodeConfigHash: '',
          stagedNodeConfigHash: '',
          commonConfigHash: '',
          optimizerConfigHash: '',
          optimizerConfigVersion: '',
          environment: {
            hazards: [],
            supports: [],
            player_state: {
              ...clone(nodes.get(key(request))!.player_state),
              ships: effectiveShipCounts(nodes.get(key(request))!, commons.get(commonKey(request))!),
            },
          },
          startedAt: new Date().toISOString(),
        },
        status: 'waiting',
        logs: '',
      }
      queue.push(item)
      publishQueue()
      queueMicrotask(() => void drainQueue())
      return clone(item)
    },
    searchQueue: async () => clone(queue),
    stopCurrent: async () => {
      webStopCurrent = true
    },
    stopAll: async () => {
      webStopCurrent = true
      for (const item of queue)
        if (item.status === 'waiting') {
          item.status = 'canceled'
          item.run = {
            exitCode: -1,
            startedAt: item.snapshot.startedAt,
            finishedAt: new Date().toISOString(),
            task: item.snapshot,
            canceled: true,
            error: '搜索被用户中止',
          }
        }
      publishQueue()
    },
    rerunGalaxy: async request => {
      const galaxy = typeof request === 'string' ? request : request.galaxy
      const target = catalog.galaxies.find(g => g.id === galaxy)!
      const now = new Date().toISOString()
      const progress: GalaxyRerunProgress = {
        galaxy,
        status: 'completed',
        total: typeof request === 'string' ? target.nodes.length : request.nodes.length,
        completed: typeof request === 'string' ? target.nodes.length : request.nodes.length,
        startedAt: now,
        finishedAt: now,
        nodes: target.nodes
          .filter(node => typeof request === 'string' || request.nodes.includes(node.id))
          .map((node, index) => {
            const selection = { galaxy, node: node.id, version: node.defaultVersion, common: target.defaultCommon }
            const current = clone(nodes.get(key(selection))!)
            const common = clone(commons.get(commonKey(selection))!)
            const search = clone(typeof request === 'string' ? searchConfig : request.search)
            const task: SearchTaskSnapshot = {
              ...selection,
              formation_columns: current.formation_columns,
              versionName: node.versions.find(item => item.id === node.defaultVersion)?.name ?? node.defaultVersion,
              commonName: target.commons.find(item => item.id === target.defaultCommon)?.name ?? target.defaultCommon,
              search,
              taskId: `${uid('rerun')}-${index}`,
              nodeConfigHash: hash(current),
              stagedNodeConfigHash: hash({ ...current, search }),
              commonConfigHash: hash(common),
              optimizerConfigHash: hash(optimizerConfig),
              optimizerConfigVersion: `sha256:${hash(optimizerConfig)}`,
              environment: {
                boss: clone(current.boss),
                hazards: clone(current.hazards),
                supports: clone(current.supports),
                player_state: { ...clone(current.player_state), ships: effectiveShipCounts(current, common) },
              },
              startedAt: now,
            }
            const run = sampleRun(selection, task)
            const priorResult = latestResultByNode.get(key(selection))
            if (priorResult) completedRuns.delete(priorResult)
            completedRuns.set(task.taskId, run)
            latestResultByNode.set(key(selection), task.taskId)
            return {
              node: node.id,
              version: node.defaultVersion,
              common: target.defaultCommon,
              status: 'succeeded' as const,
              startedAt: now,
              finishedAt: now,
              changed: hasRerunChange(run.result?.verified_baseline, run.result?.best_result),
              run,
            }
          }),
      }
      progressListeners.forEach(listener => listener(clone(progress)))
      return progress
    },
    useBest: async taskId => {
      const run = completedRuns.get(taskId) ?? lastSearch
      const task = run?.task
      const now = new Date().toISOString()
      if (!task || task.taskId !== taskId || !run?.result?.best_result)
        return { exitCode: -1, startedAt: now, finishedAt: now, error: '搜索任务不存在或已失效。' }
      const selection: Selection = task
      if (latestResultByNode.get(key(selection)) !== taskId)
        return {
          exitCode: -1,
          startedAt: now,
          finishedAt: now,
          error: '该节点的结果已被后续搜索覆盖，请重新搜索后再应用。',
        }
      if (hash(nodes.get(key(selection))) !== task.nodeConfigHash)
        return {
          exitCode: -1,
          startedAt: now,
          finishedAt: now,
          error: '目标 Version 在搜索后已变化，未应用 Best Found。',
        }
      const current = clone(nodes.get(key(selection))!)
      const best = run.result.best_result
      const columns = formationColumns(current.formation_columns)
      const formationError = formationResultError(best.formation, run.result.base_config, columns)
      if (formationError)
        return {
          exitCode: -1,
          startedAt: now,
          finishedAt: now,
          error: formationError,
        }
      const formation: NodeConfig['baseline']['formation'] = {}
      for (const entry of best.formation) {
        const ship = shipSelectorToId(entry.ship)
        if (ship) {
          formation[entry.position] = preserveShipSelectorFormat(current.baseline.formation[entry.position], ship)
        }
      }
      current.baseline.formation = formation
      for (const [ship, loadout] of Object.entries(best.ship_loadouts ?? {})) {
        const id = shipSelectorToId(ship)
        if (!id) continue
        current.baseline.loadouts[id] = {
          primary: loadout.primary ?? null,
          secondary: loadout.secondary ?? null,
          tertiary_mods: loadout.tertiary_mods ?? [],
        }
      }
      nodes.set(key(selection), nodeConfigSchema.parse(current))
      persistWorkspace()
      return { exitCode: 0, startedAt: now, finishedAt: now, node: clone(current) }
    },
    onOutput: listener => {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
    onSearchTask: listener => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    onSearchQueue: listener => {
      queueListeners.add(listener)
      return () => queueListeners.delete(listener)
    },
    onGalaxyProgress: listener => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
  }
  return api
}

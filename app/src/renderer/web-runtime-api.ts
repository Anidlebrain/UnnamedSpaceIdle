import type {
  Catalog,
  FleetManagerApi,
  GalaxyRerunProgress,
  NamedItem,
  RunResult,
  Selection,
} from '../shared/contracts'
import type { CommonConfig, NodeConfig, OptimizerConfig } from '../shared/schemas'
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
    ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'].map(ship => [ship, { min: 0, max: 10 }]),
  ),
  allowed_mod_slots: {
    Fighter: { primary: [null, 'FighterMiniRailgunMod'], secondary: [null] },
    Corvette: { primary: [null, 'CorvetteChargeLaserMod'], secondary: [null, 'ShieldMod'] },
    Frigate: { primary: [null, 'FrigateMissileMod'], secondary: [null, 'ArmorMod'] },
    Cruiser: { primary: [null], secondary: [null, 'CruiserSingleArmorTank'] },
    HeavyCruiser: { primary: [null, 'HeavyCruiserBeamMod'], secondary: [null] },
  },
  max_total_groups: 10,
  max_groups_per_ship: Object.fromEntries(
    ['Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser'].map(ship => [ship, 10]),
  ),
  max_simulations: 1_000_000,
  max_wall_seconds: 300,
  top_n: 10,
  kill_refine_top_n: 3,
  kill_sequence_max_battles: 100,
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
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

restoreWorkspace()

const key = ({ galaxy, node, version }: Selection) => `${galaxy}/${node}/${version}`
const commonKey = ({ galaxy, common }: Selection) => `${galaxy}/${common}`
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}`

function setDefault(items: NamedItem[], id: string) {
  for (const item of items) item.isDefault = item.id === id
}

function sampleRun(selection: Selection): RunResult {
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
  const outputListeners = new Set<(line: string) => void>()
  const progressListeners = new Set<(progress: GalaxyRerunProgress) => void>()
  return {
    runtime: 'web',
    previewImport: async () => ({ galaxies: [] }),
    importMap: async () => undefined,
    catalog: async () => clone(catalog),
    load: async selection => ({
      node: clone(nodes.get(key(selection)) ?? makeNode(Number(selection.galaxy.slice(1)), selection.node)),
      common: clone(commons.get(commonKey(selection)) ?? defaultCommon),
    }),
    loadOptimizerConfig: async () => clone(optimizerConfig),
    save: async (selection, node) => {
      nodes.set(key(selection), clone(node))
      persistWorkspace()
    },
    saveCommon: async (selection, common) => {
      commons.set(commonKey(selection), clone(common))
      persistWorkspace()
    },
    saveOptimizerConfig: async config => {
      optimizerConfig = clone(config)
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
    run: async selection => {
      outputListeners.forEach(listener => listener('读取配置…\n搜索候选阵型…\n验证 Best Found…\n完成。\n'))
      return sampleRun(selection)
    },
    rerunGalaxy: async galaxy => {
      const target = catalog.galaxies.find(g => g.id === galaxy)!
      const now = new Date().toISOString()
      const progress: GalaxyRerunProgress = {
        galaxy,
        status: 'completed',
        total: target.nodes.length,
        completed: target.nodes.length,
        startedAt: now,
        finishedAt: now,
        nodes: target.nodes.map((node, index) => ({
          node: node.id,
          version: node.defaultVersion,
          common: target.defaultCommon,
          status: 'succeeded',
          startedAt: now,
          finishedAt: now,
          changed: index === 0,
          run: sampleRun({ galaxy, node: node.id, version: node.defaultVersion, common: target.defaultCommon }),
        })),
      }
      progressListeners.forEach(listener => listener(clone(progress)))
      return progress
    },
    useBest: async selection => {
      const current = clone(nodes.get(key(selection))!)
      const best = sampleRun(selection).result?.best_result?.formation ?? []
      for (const entry of best) {
        const ship = shipSelectorToId(entry.ship)
        if (ship) {
          current.baseline.formation[entry.position] = preserveShipSelectorFormat(
            current.baseline.formation[entry.position],
            ship,
          )
        }
      }
      nodes.set(key(selection), current)
      persistWorkspace()
      const now = new Date().toISOString()
      return { exitCode: 0, startedAt: now, finishedAt: now, node: clone(current) }
    },
    onOutput: listener => {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
    onGalaxyProgress: listener => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
  }
}

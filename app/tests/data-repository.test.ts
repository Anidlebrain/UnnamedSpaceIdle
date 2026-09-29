import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRepository } from '../src/main/services/data-repository'
import type { NodeConfig } from '../src/shared/schemas'

const roots: string[] = []
const node: NodeConfig = {
  galaxy: 6,
  node: 'B1',
  hazards: [],
  supports: [],
  player_state: { fleet_resources: 1, ships: {} },
  baseline: { enabled: true, formation: {}, loadouts: {} },
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step' as const,
    max_wall_seconds: 1,
    max_simulations: 1,
    workers: 1,
  },
}
const common = { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } }
const optimizer = {
  objective: 'normal',
  future_field: { preserved: true },
  mode: 'realistic',
  ship_types: ['Fighter'],
  group_ranges: { Fighter: { min: 0, max: 10 } },
  allowed_mod_slots: { Fighter: { primary: [null, 'FighterMiniRailgunMod'], secondary: [null] } },
  max_total_groups: 10,
  max_groups_per_ship: { Fighter: 10 },
  max_simulations: 100,
  max_wall_seconds: 30,
  top_n: 10,
  kill_refine_top_n: 3,
  kill_sequence_max_battles: 100,
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fleet-manager-'))
  roots.push(root)
  const map = join(root, 'map')
  await writeFile(join(root, 'placeholder'), '')
  await (await import('node:fs/promises')).mkdir(join(map, 'g6'), { recursive: true })
  await (await import('node:fs/promises')).mkdir(join(root, 'poc'), { recursive: true })
  await writeFile(join(map, 'g6', 'B1.json'), JSON.stringify(node))
  await writeFile(join(map, 'g6', 'common.json'), JSON.stringify(common))
  await writeFile(join(root, 'poc', 'optimizer_v2_daily.json'), `${JSON.stringify(optimizer, null, 4)}\n`)
  await writeFile(join(root, 'poc', 'search_config.json'), `${JSON.stringify(node.search, null, 2)}\n`)
  return { root, map, repo: new DataRepository(join(root, 'data'), map) }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
describe('DataRepository', () => {
  it('imports only after explicit call, validates and atomically saves a version', async () => {
    const { repo } = await fixture()
    expect((await repo.previewImport()).galaxies[0].nodes).toEqual(['B1'])
    await repo.importMap()
    const selection = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    expect((await repo.load(selection)).node.node).toBe('B1')
    await repo.save(selection, { ...node, hazards: ['test'] })
    expect(
      JSON.parse(
        await readFile(join(roots[0], 'data', 'galaxies', 'g6', 'nodes', 'B1', 'versions', 'default.json'), 'utf8'),
      ).hazards,
    ).toEqual(['test'])
  })
  it('does not overwrite existing Manager data on reimport', async () => {
    const { repo } = await fixture()
    await repo.importMap()
    await expect(repo.importMap()).rejects.toThrow('will not overwrite')
  })
  it('stages missing baseline loadouts as no Mod without rewriting the saved Version', async () => {
    const { repo, root } = await fixture()
    await repo.importMap()
    const selection = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    const original: NodeConfig = {
      ...node,
      baseline: {
        enabled: true,
        formation: { A1: 4, A2: 1 },
        loadouts: { Fighter: { primary: 1, secondary: 0 } },
      },
    }
    const savedPath = join(root, 'data', 'galaxies', 'g6', 'nodes', 'B1', 'versions', 'default.json')
    await writeFile(savedPath, `${JSON.stringify(original, null, 2)}\n`)
    const before = await readFile(savedPath, 'utf8')

    const loaded = await repo.load(selection)
    expect(loaded.node.baseline.loadouts).toMatchObject({
      Fighter: { primary: 1, secondary: 0 },
      Cruiser: { primary: 0, secondary: 0 },
    })
    await repo.stageValues(selection, loaded.node, loaded.common)
    expect(JSON.parse(await readFile(join(root, 'map', 'g6', 'B1.json'), 'utf8')).baseline.loadouts.Cruiser).toEqual({
      primary: 0,
      secondary: 0,
    })
    expect(await readFile(savedPath, 'utf8')).toBe(before)
  })
  it('keeps negative node ship deltas in Manager data and stages nonnegative effective counts', async () => {
    const { repo, root } = await fixture()
    await repo.importMap()
    const selection = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    const source = {
      ...node,
      player_state: { ...node.player_state, ships: { Fighter: -2, Corvette: 1 } },
      search: { ...node.search, strategy: 'advisor_seeded' as const },
    }
    const shared = { ...common, ships: { Fighter: 1, Corvette: 2 } }
    await repo.save(selection, source)
    await repo.saveCommon(selection, shared)
    await repo.stage(selection)
    const staged = JSON.parse(await readFile(join(root, 'map', 'g6', 'B1.json'), 'utf8'))
    const stagedCommon = JSON.parse(await readFile(join(root, 'map', 'g6', 'common.json'), 'utf8'))
    expect(staged.player_state.ships).toEqual({ Fighter: 0, Corvette: 3 })
    expect(staged.search.strategy).toBe('advisor_seeded')
    expect(stagedCommon.ships).toBeUndefined()
    expect((await repo.load(selection)).node.player_state.ships).toEqual({ Fighter: -2, Corvette: 1 })
  })
  it('loads the committed Search fallback and persists user changes only under map', async () => {
    const { repo, root } = await fixture()
    await repo.importMap()
    const selection = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    await repo.save(selection, { ...node, hazards: ['new-node-edit'] })
    const search = { ...node.search, max_wall_seconds: 99, target_used_fr: 27.3 }
    expect(await repo.configSources()).toMatchObject({ search: 'default' })
    expect((await repo.loadSearchConfig()).max_wall_seconds).toBe(1)
    const saved = await repo.saveSearchConfig(search)
    expect(saved.max_wall_seconds).toBe(99)
    expect(saved.target_used_fr).toBeUndefined()
    expect(await repo.configSources()).toMatchObject({ search: 'local' })
    expect(JSON.parse(await readFile(join(root, 'map', 'search_config.json'), 'utf8')).max_wall_seconds).toBe(99)
    expect(JSON.parse(await readFile(join(root, 'map', 'search_config.json'), 'utf8')).target_used_fr).toBeUndefined()
    expect((await repo.load(selection)).node.hazards).toEqual(['new-node-edit'])
  })
  it('uses the Optimizer fallback until a local override is saved and preserves unknown fields', async () => {
    const { repo, root } = await fixture()
    const fallbackPath = join(root, 'poc', 'optimizer_v2_daily.json')
    const localPath = join(root, 'map', 'optimizer_v2_daily.json')
    const before = await readFile(fallbackPath, 'utf8')
    const loaded = await repo.loadOptimizerConfig()
    expect(await repo.configSources()).toMatchObject({ optimizer: 'default' })
    await repo.saveOptimizerConfig({ ...loaded, max_wall_seconds: 45 })
    const after = await readFile(localPath, 'utf8')
    expect(await readFile(fallbackPath, 'utf8')).toBe(before)
    expect(await repo.configSources()).toMatchObject({ optimizer: 'local' })
    expect(after).toContain('\n    "mode"')
    expect(after.indexOf('"future_field"')).toBeLessThan(after.indexOf('"mode"'))
    expect(JSON.parse(after)).toMatchObject({ max_wall_seconds: 45, future_field: { preserved: true } })
  })
  it('keeps Node Versions isolated and safely manages names and defaults', async () => {
    const { repo } = await fixture()
    await repo.importMap()
    const base = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    const special = await repo.createVersion(base, 'Support F2')
    const selected = { ...base, version: special }
    await repo.save(selected, { ...node, hazards: ['special'] })
    expect((await repo.load(base)).node.hazards).toEqual([])
    expect((await repo.load(selected)).node.hazards).toEqual(['special'])
    await repo.renameVersion(selected, 'Support F2 renamed')
    await repo.setDefaultVersion(selected)
    let catalog = await repo.catalog()
    expect(catalog.galaxies[0].nodes[0].defaultVersion).toBe(special)
    expect(catalog.galaxies[0].nodes[0].versions.find(v => v.id === special)?.name).toBe('Support F2 renamed')
    await expect(repo.deleteVersion(selected)).rejects.toThrow('default Version')
    await repo.setDefaultVersion(base)
    await repo.deleteVersion(selected)
    catalog = await repo.catalog()
    expect(catalog.galaxies[0].nodes[0].versions.map(v => v.id)).toEqual(['default'])
  })
  it('keeps Common configurations isolated and protects the default', async () => {
    const { repo } = await fixture()
    await repo.importMap()
    const base = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    const buff = await repo.createCommon(base, '临时 Buff')
    const selected = { ...base, common: buff }
    await repo.saveCommon(selected, { ...common, temporary: { damage_scale: 0.5, health_scale: 0.2 } })
    expect((await repo.load(base)).common.temporary.damage_scale).toBe(0)
    expect((await repo.load(selected)).common.temporary.damage_scale).toBe(0.5)
    await repo.setDefaultCommon(selected)
    await expect(repo.deleteCommon(selected)).rejects.toThrow('default Common')
    await repo.setDefaultCommon(base)
    await repo.renameCommon(selected, 'Buff renamed')
    await repo.deleteCommon(selected)
    expect((await repo.catalog()).galaxies[0].commons.map(c => c.id)).toEqual(['default'])
  })
  it('creates Nodes from a Version or managed template and rewrites only identity', async () => {
    const { repo } = await fixture()
    await repo.importMap()
    const source = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    await repo.save(source, { ...node, hazards: ['kept'] })
    const template = await repo.createTemplate(source, '普通 Boss')
    await repo.renameTemplate(template, '普通 Boss 模板')
    await repo.createNode({
      galaxy: 'g6',
      node: 'B2',
      versionName: '复制版',
      source: { type: 'selection', selection: source },
    })
    await repo.createNode({ galaxy: 'g6', node: 'B3', versionName: '模板版', source: { type: 'template', template } })
    const b2 = await repo.load({ galaxy: 'g6', node: 'B2', version: 'default', common: 'default' })
    const b3 = await repo.load({ galaxy: 'g6', node: 'B3', version: 'default', common: 'default' })
    expect({ galaxy: b2.node.galaxy, node: b2.node.node, hazards: b2.node.hazards }).toEqual({
      galaxy: 6,
      node: 'B2',
      hazards: ['kept'],
    })
    expect({ galaxy: b3.node.galaxy, node: b3.node.node, hazards: b3.node.hazards }).toEqual({
      galaxy: 6,
      node: 'B3',
      hazards: ['kept'],
    })
    expect((await repo.catalog()).templates[0].name).toBe('普通 Boss 模板')
    await repo.deleteTemplate(template)
    expect((await repo.catalog()).templates).toEqual([])
  })
  it('creates a Galaxy with copied Common and an initial Node without overwriting existing data', async () => {
    const { repo } = await fixture()
    await repo.importMap()
    const source = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }
    await repo.save(source, { ...node, hazards: ['kept'] })
    const request = { galaxy: 'g7', node: 'B2', versionName: '起始版', source }
    expect(await repo.createGalaxy(request)).toEqual({ node: 'B2', version: 'default', common: 'default' })
    const target = { galaxy: 'g7', node: 'B2', version: 'default', common: 'default' }
    const loaded = await repo.load(target)
    expect({ galaxy: loaded.node.galaxy, node: loaded.node.node, hazards: loaded.node.hazards }).toEqual({
      galaxy: 7,
      node: 'B2',
      hazards: ['kept'],
    })
    expect(loaded.common).toEqual(common)
    expect((await repo.catalog()).galaxies.find(item => item.id === 'g7')?.nodes[0].versions[0].name).toBe('起始版')
    await expect(repo.createGalaxy(request)).rejects.toThrow('already exists')
    expect((await repo.load(target)).node.hazards).toEqual(['kept'])
  })
})

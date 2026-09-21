import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRepository } from '../src/main/services/data-repository'

const roots: string[] = []
const node = { galaxy: 6, node: 'B1', hazards: [], supports: [], player_state: { fleet_resources: 1, ships: {} }, baseline: { enabled: true, formation: {}, loadouts: {} }, search: { profile: 'fast', goal: 'beat_baseline', simulation_clock: 'offline_fixed_step' as const, max_wall_seconds: 1, max_simulations: 1, workers: 1 } }
const common = { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } }
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'fleet-manager-')); roots.push(root); const map = join(root, 'map'); await writeFile(join(root, 'placeholder'), ''); await (await import('node:fs/promises')).mkdir(join(map, 'g6'), { recursive: true }); await writeFile(join(map, 'g6', 'B1.json'), JSON.stringify(node)); await writeFile(join(map, 'g6', 'common.json'), JSON.stringify(common)); return { root, map, repo: new DataRepository(join(root, 'data'), map) } }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('DataRepository', () => { it('imports only after explicit call, validates and atomically saves a version', async () => { const { repo } = await fixture(); expect((await repo.previewImport()).galaxies[0].nodes).toEqual(['B1']); await repo.importMap(); const selection = { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' }; expect((await repo.load(selection)).node.node).toBe('B1'); await repo.save(selection, { ...node, hazards: ['test'] }); expect(JSON.parse(await readFile(join(roots[0], 'data', 'galaxies', 'g6', 'nodes', 'B1', 'versions', 'default.json'), 'utf8')).hazards).toEqual(['test']) }); it('does not overwrite existing Manager data on reimport', async () => { const { repo } = await fixture(); await repo.importMap(); await expect(repo.importMap()).rejects.toThrow('will not overwrite') }) })

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  commonConfigSchema,
  commonMetaSchema,
  nodeConfigSchema,
  optimizerConfigSchema,
  searchConfigSchema,
  templateMetaSchema,
  versionMetaSchema,
  type CommonConfig,
  type NodeConfig,
  type OptimizerConfig,
  type SearchConfig,
} from '../../shared/schemas'
import type { Catalog, CreateGalaxyRequest, CreateNodeRequest, ImportPreview, Selection } from '../../shared/contracts'
import { effectiveShipCounts } from '../../shared/ship-counts'
import { withoutNodeTarget } from '../../shared/search-target'

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const itemPattern = /^[A-Za-z0-9_-]+$/
const assertItem = (value: string, label: string) => {
  if (!itemPattern.test(value)) throw new Error(`${label} contains unsupported characters.`)
}
const assertName = (value: string) => {
  const name = value.trim()
  if (!name) throw new Error('Name is required.')
  if (name.length > 80) throw new Error('Name must be 80 characters or fewer.')
  return name
}
const newId = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  }-${randomUUID().slice(0, 8)}`

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

async function atomicText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, value, 'utf8')
  await rename(tmp, path)
}

function preserveObjectOrder(current: unknown, next: unknown): unknown {
  if (Array.isArray(next)) return next
  if (!current || !next || typeof current !== 'object' || typeof next !== 'object') return next
  const currentObject = current as Record<string, unknown>
  const nextObject = next as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  for (const key of Object.keys(currentObject)) {
    if (key in nextObject) merged[key] = preserveObjectOrder(currentObject[key], nextObject[key])
  }
  for (const key of Object.keys(nextObject)) {
    if (!(key in merged)) merged[key] = nextObject[key]
  }
  return merged
}

export class DataRepository {
  private readonly optimizerConfigPath: string
  private readonly optimizerFallbackPath: string
  private readonly searchConfigPath: string
  private readonly searchFallbackPath: string
  constructor(
    private readonly dataRoot: string,
    private readonly mapRoot: string,
    optimizerConfigPath?: string,
  ) {
    const fleetRoot = dirname(mapRoot)
    this.optimizerConfigPath = optimizerConfigPath ?? join(mapRoot, 'optimizer_v2_daily.json')
    this.optimizerFallbackPath = join(fleetRoot, 'poc', 'optimizer_v2_daily.json')
    this.searchConfigPath = join(mapRoot, 'search_config.json')
    this.searchFallbackPath = join(fleetRoot, 'poc', 'search_config.json')
  }
  private validateSelection(s: Selection) {
    if (!/^g\d+$/i.test(s.galaxy)) throw new Error('Invalid Galaxy.')
    assertItem(s.node, 'Node')
    assertItem(s.version, 'Version')
    assertItem(s.common, 'Common')
  }
  private galaxyPath(galaxy: string) {
    if (!/^g\d+$/i.test(galaxy)) throw new Error('Invalid Galaxy.')
    return join(this.dataRoot, 'galaxies', galaxy)
  }
  private nodeDir(s: Pick<Selection, 'galaxy' | 'node'>) {
    assertItem(s.node, 'Node')
    return join(this.galaxyPath(s.galaxy), 'nodes', s.node)
  }
  private nodeMetaPath(s: Pick<Selection, 'galaxy' | 'node'>) {
    return join(this.nodeDir(s), 'meta.json')
  }
  private commonDir(galaxy: string) {
    return join(this.galaxyPath(galaxy), 'common')
  }
  private templateDir() {
    return join(this.dataRoot, 'templates')
  }
  private templateMetaPath() {
    return join(this.templateDir(), 'meta.json')
  }
  private async templateMeta() {
    try {
      return templateMetaSchema.parse(await readJson(this.templateMetaPath()))
    } catch (error) {
      if (missing(error)) return { templates: [] }
      throw error
    }
  }
  private ensureUniqueName(items: Array<{ id: string; name: string }>, name: string, except?: string) {
    if (
      items.some(
        item => item.id !== except && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
      )
    )
      throw new Error(`Name “${name}” already exists.`)
  }

  async previewImport(): Promise<ImportPreview> {
    const entries = await readdir(this.mapRoot, { withFileTypes: true })
    const galaxies = await Promise.all(
      entries
        .filter(e => e.isDirectory() && /^g\d+$/i.test(e.name))
        .map(async e => {
          const children = await readdir(join(this.mapRoot, e.name))
          return {
            id: e.name,
            nodes: children
              .filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n) && n !== 'common.json')
              .map(n => n.slice(0, -5)),
            common: children.includes('common.json'),
          }
        }),
    )
    return { galaxies }
  }

  async importMap(): Promise<void> {
    const preview = await this.previewImport()
    for (const galaxy of preview.galaxies) {
      const target = this.galaxyPath(galaxy.id)
      try {
        await stat(target)
        throw new Error(`Manager data already exists for ${galaxy.id}; import will not overwrite it.`)
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (!galaxy.common) throw new Error(`${galaxy.id} has no common.json; import was not started.`)
      const source = join(this.mapRoot, galaxy.id)
      const common = commonConfigSchema.parse(await readJson(join(source, 'common.json')))
      await atomicJson(join(target, 'common', 'versions', 'default.json'), common)
      await atomicJson(join(target, 'common', 'meta.json'), {
        default_profile: 'default',
        profiles: [{ id: 'default', name: '默认' }],
      })
      for (const node of galaxy.nodes) {
        const config = nodeConfigSchema.parse(await readJson(join(source, `${node}.json`)))
        await atomicJson(join(target, 'nodes', node, 'versions', 'default.json'), config)
        await atomicJson(join(target, 'nodes', node, 'meta.json'), {
          default_version: 'default',
          versions: [{ id: 'default', name: '默认' }],
        })
      }
    }
  }

  async catalog(): Promise<Catalog> {
    try {
      const dirs = await readdir(join(this.dataRoot, 'galaxies'), { withFileTypes: true })
      const galaxies = await Promise.all(
        dirs
          .filter(d => d.isDirectory() && /^g\d+$/i.test(d.name))
          .map(async d => {
            const root = this.galaxyPath(d.name)
            const commonMeta = commonMetaSchema.parse(await readJson(join(root, 'common', 'meta.json')))
            const nodeDirs = await readdir(join(root, 'nodes'), { withFileTypes: true })
            const nodes = await Promise.all(
              nodeDirs
                .filter(n => n.isDirectory())
                .map(async n => {
                  const meta = versionMetaSchema.parse(await readJson(join(root, 'nodes', n.name, 'meta.json')))
                  return {
                    id: n.name,
                    defaultVersion: meta.default_version,
                    versions: meta.versions.map(v => ({ ...v, isDefault: v.id === meta.default_version })),
                  }
                }),
            )
            nodes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
            return {
              id: d.name,
              nodes,
              defaultCommon: commonMeta.default_profile,
              commons: commonMeta.profiles.map(p => ({ ...p, isDefault: p.id === commonMeta.default_profile })),
            }
          }),
      )
      galaxies.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      return { galaxies, templates: (await this.templateMeta()).templates }
    } catch (error) {
      if (missing(error)) return { galaxies: [], templates: [] }
      throw error
    }
  }

  async galaxyDefaultSelections(galaxy: string): Promise<Selection[]> {
    const root = this.galaxyPath(galaxy)
    let commonMeta
    let nodeDirs
    try {
      commonMeta = commonMetaSchema.parse(await readJson(join(root, 'common', 'meta.json')))
      nodeDirs = await readdir(join(root, 'nodes'), { withFileTypes: true })
    } catch (error) {
      if (missing(error)) throw new Error(`Galaxy ${galaxy} does not exist or is incomplete in Manager data.`)
      throw error
    }
    if (!commonMeta.profiles.some(item => item.id === commonMeta.default_profile))
      throw new Error(`${galaxy} has no valid default Common configuration.`)
    commonConfigSchema.parse(await readJson(join(root, 'common', 'versions', `${commonMeta.default_profile}.json`)))
    const nodes = nodeDirs.filter(item => item.isDirectory())
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return Promise.all(
      nodes.map(async node => {
        const meta = versionMetaSchema.parse(await readJson(join(root, 'nodes', node.name, 'meta.json')))
        if (!meta.versions.some(item => item.id === meta.default_version))
          throw new Error(`${galaxy}/${node.name} has no valid default Version.`)
        return {
          galaxy,
          node: node.name,
          version: meta.default_version,
          common: commonMeta.default_profile,
        }
      }),
    )
  }

  async load(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }> {
    this.validateSelection(selection)
    const node = nodeConfigSchema.parse(
      await readJson(join(this.nodeDir(selection), 'versions', `${selection.version}.json`)),
    )
    const common = commonConfigSchema.parse(
      await readJson(join(this.commonDir(selection.galaxy), 'versions', `${selection.common}.json`)),
    )
    this.assertIdentity(selection, node)
    return { node, common }
  }

  private async effectivePath(local: string, fallback: string): Promise<{ path: string; source: 'local' | 'default' }> {
    try {
      await stat(local)
      return { path: local, source: 'local' }
    } catch (error) {
      if (!missing(error)) throw error
      return { path: fallback, source: 'default' }
    }
  }

  async configSources(): Promise<{ search: 'local' | 'default'; optimizer: 'local' | 'default' }> {
    const [search, optimizer] = await Promise.all([
      this.effectivePath(this.searchConfigPath, this.searchFallbackPath),
      this.effectivePath(this.optimizerConfigPath, this.optimizerFallbackPath),
    ])
    return { search: search.source, optimizer: optimizer.source }
  }

  async loadOptimizerConfig(): Promise<OptimizerConfig> {
    const effective = await this.effectivePath(this.optimizerConfigPath, this.optimizerFallbackPath)
    return optimizerConfigSchema.parse(await readJson(effective.path))
  }

  async saveOptimizerConfig(config: OptimizerConfig): Promise<void> {
    const parsed = optimizerConfigSchema.parse(config)
    const effective = await this.effectivePath(this.optimizerConfigPath, this.optimizerFallbackPath)
    const source = await readFile(effective.path, 'utf8')
    const sourceObject = JSON.parse(source)
    const current = optimizerConfigSchema.parse(sourceObject)
    if (effective.source === 'local' && isDeepStrictEqual(current, parsed) && isDeepStrictEqual(sourceObject, parsed))
      return
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    const indent = source.match(/\r?\n([ \t]+)"/)?.[1] ?? '  '
    const trailingNewline = /\r?\n$/.test(source)
    const nextValue = preserveObjectOrder(sourceObject, parsed)
    const next = JSON.stringify(nextValue, null, indent).replace(/\n/g, newline) + (trailingNewline ? newline : '')
    await atomicText(this.optimizerConfigPath, next)
  }

  async loadSearchConfig(): Promise<SearchConfig> {
    const effective = await this.effectivePath(this.searchConfigPath, this.searchFallbackPath)
    return withoutNodeTarget(searchConfigSchema.parse(await readJson(effective.path)))
  }

  async saveSearchConfig(config: SearchConfig): Promise<SearchConfig> {
    const parsed = withoutNodeTarget(searchConfigSchema.parse(config))
    const effective = await this.effectivePath(this.searchConfigPath, this.searchFallbackPath)
    const current = searchConfigSchema.parse(await readJson(effective.path))
    if (effective.source !== 'local' || !isDeepStrictEqual(current, parsed))
      await atomicJson(this.searchConfigPath, parsed)
    return this.loadSearchConfig()
  }

  private assertIdentity(selection: Pick<Selection, 'galaxy' | 'node'>, node: NodeConfig) {
    if (
      node.galaxy !== Number(selection.galaxy.slice(1)) ||
      node.node.toLowerCase() !== selection.node.replace(/_num$/i, '').toLowerCase()
    )
      throw new Error(`Node JSON does not match ${selection.galaxy}/${selection.node}.`)
  }

  async save(selection: Selection, node: NodeConfig): Promise<void> {
    this.validateSelection(selection)
    const parsed = nodeConfigSchema.parse(node)
    this.assertIdentity(selection, parsed)
    await atomicJson(join(this.nodeDir(selection), 'versions', `${selection.version}.json`), parsed)
  }

  async nodeHash(selection: Selection): Promise<string> {
    return this.hash((await this.load(selection)).node)
  }

  async configHashes(selection: Selection): Promise<{
    node: NodeConfig
    common: CommonConfig
    optimizer: OptimizerConfig
    nodeConfigHash: string
    commonConfigHash: string
    optimizerConfigHash: string
  }> {
    const { node, common } = await this.load(selection)
    const optimizer = await this.loadOptimizerConfig()
    return {
      node,
      common,
      optimizer,
      nodeConfigHash: this.hash(node),
      commonConfigHash: this.hash(common),
      optimizerConfigHash: this.hash(optimizer),
    }
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }

  async saveCommon(selection: Selection, common: CommonConfig): Promise<void> {
    this.validateSelection(selection)
    await atomicJson(
      join(this.commonDir(selection.galaxy), 'versions', `${selection.common}.json`),
      commonConfigSchema.parse(common),
    )
  }

  async createVersion(selection: Selection, displayName: string): Promise<string> {
    this.validateSelection(selection)
    const name = assertName(displayName)
    const meta = versionMetaSchema.parse(await readJson(this.nodeMetaPath(selection)))
    this.ensureUniqueName(meta.versions, name)
    const source = nodeConfigSchema.parse(
      await readJson(join(this.nodeDir(selection), 'versions', `${selection.version}.json`)),
    )
    const id = newId(name)
    await atomicJson(join(this.nodeDir(selection), 'versions', `${id}.json`), source)
    await atomicJson(this.nodeMetaPath(selection), { ...meta, versions: [...meta.versions, { id, name }] })
    return id
  }

  async renameVersion(selection: Selection, displayName: string): Promise<void> {
    this.validateSelection(selection)
    const name = assertName(displayName)
    const meta = versionMetaSchema.parse(await readJson(this.nodeMetaPath(selection)))
    this.ensureUniqueName(meta.versions, name, selection.version)
    if (!meta.versions.some(v => v.id === selection.version)) throw new Error('Version no longer exists.')
    await atomicJson(this.nodeMetaPath(selection), {
      ...meta,
      versions: meta.versions.map(v => (v.id === selection.version ? { ...v, name } : v)),
    })
  }

  async deleteVersion(selection: Selection): Promise<void> {
    this.validateSelection(selection)
    const meta = versionMetaSchema.parse(await readJson(this.nodeMetaPath(selection)))
    if (meta.versions.length <= 1) throw new Error('A Node must keep at least one Version.')
    if (meta.default_version === selection.version)
      throw new Error('The default Version cannot be deleted. Set another default first.')
    if (!meta.versions.some(v => v.id === selection.version)) throw new Error('Version no longer exists.')
    await atomicJson(this.nodeMetaPath(selection), {
      ...meta,
      versions: meta.versions.filter(v => v.id !== selection.version),
    })
    await rm(join(this.nodeDir(selection), 'versions', `${selection.version}.json`))
  }

  async setDefaultVersion(selection: Selection): Promise<void> {
    this.validateSelection(selection)
    const meta = versionMetaSchema.parse(await readJson(this.nodeMetaPath(selection)))
    if (!meta.versions.some(v => v.id === selection.version)) throw new Error('Version no longer exists.')
    await atomicJson(this.nodeMetaPath(selection), { ...meta, default_version: selection.version })
  }

  async createCommon(selection: Selection, displayName: string): Promise<string> {
    this.validateSelection(selection)
    const name = assertName(displayName)
    const metaPath = join(this.commonDir(selection.galaxy), 'meta.json')
    const meta = commonMetaSchema.parse(await readJson(metaPath))
    this.ensureUniqueName(meta.profiles, name)
    const source = commonConfigSchema.parse(
      await readJson(join(this.commonDir(selection.galaxy), 'versions', `${selection.common}.json`)),
    )
    const id = newId(name)
    await atomicJson(join(this.commonDir(selection.galaxy), 'versions', `${id}.json`), source)
    await atomicJson(metaPath, { ...meta, profiles: [...meta.profiles, { id, name }] })
    return id
  }

  async renameCommon(selection: Selection, displayName: string): Promise<void> {
    this.validateSelection(selection)
    const name = assertName(displayName)
    const path = join(this.commonDir(selection.galaxy), 'meta.json')
    const meta = commonMetaSchema.parse(await readJson(path))
    this.ensureUniqueName(meta.profiles, name, selection.common)
    if (!meta.profiles.some(v => v.id === selection.common)) throw new Error('Common no longer exists.')
    await atomicJson(path, {
      ...meta,
      profiles: meta.profiles.map(v => (v.id === selection.common ? { ...v, name } : v)),
    })
  }

  async deleteCommon(selection: Selection): Promise<void> {
    this.validateSelection(selection)
    const path = join(this.commonDir(selection.galaxy), 'meta.json')
    const meta = commonMetaSchema.parse(await readJson(path))
    if (meta.profiles.length <= 1) throw new Error('A Galaxy must keep at least one Common configuration.')
    if (meta.default_profile === selection.common)
      throw new Error('The default Common cannot be deleted. Set another default first.')
    if (!meta.profiles.some(v => v.id === selection.common)) throw new Error('Common no longer exists.')
    await atomicJson(path, { ...meta, profiles: meta.profiles.filter(v => v.id !== selection.common) })
    await rm(join(this.commonDir(selection.galaxy), 'versions', `${selection.common}.json`))
  }

  async setDefaultCommon(selection: Selection): Promise<void> {
    this.validateSelection(selection)
    const path = join(this.commonDir(selection.galaxy), 'meta.json')
    const meta = commonMetaSchema.parse(await readJson(path))
    if (!meta.profiles.some(v => v.id === selection.common)) throw new Error('Common no longer exists.')
    await atomicJson(path, { ...meta, default_profile: selection.common })
  }

  async createTemplate(selection: Selection, displayName: string): Promise<string> {
    this.validateSelection(selection)
    const name = assertName(displayName)
    const meta = await this.templateMeta()
    this.ensureUniqueName(meta.templates, name)
    const node = nodeConfigSchema.parse(
      await readJson(join(this.nodeDir(selection), 'versions', `${selection.version}.json`)),
    )
    const id = newId(name)
    await atomicJson(join(this.templateDir(), `${id}.json`), node)
    await atomicJson(this.templateMetaPath(), { templates: [...meta.templates, { id, name }] })
    return id
  }

  async renameTemplate(id: string, displayName: string): Promise<void> {
    assertItem(id, 'Template')
    const name = assertName(displayName)
    const meta = await this.templateMeta()
    this.ensureUniqueName(meta.templates, name, id)
    if (!meta.templates.some(v => v.id === id)) throw new Error('Template no longer exists.')
    await atomicJson(this.templateMetaPath(), {
      templates: meta.templates.map(v => (v.id === id ? { ...v, name } : v)),
    })
  }

  async deleteTemplate(id: string): Promise<void> {
    assertItem(id, 'Template')
    const meta = await this.templateMeta()
    if (!meta.templates.some(v => v.id === id)) throw new Error('Template no longer exists.')
    await atomicJson(this.templateMetaPath(), { templates: meta.templates.filter(v => v.id !== id) })
    await rm(join(this.templateDir(), `${id}.json`))
  }

  async createNode(request: CreateNodeRequest): Promise<{ node: string; version: string }> {
    if (!/^g\d+$/i.test(request.galaxy)) throw new Error('Invalid target Galaxy.')
    assertItem(request.node, 'Target Node')
    const versionName = assertName(request.versionName)
    const target = this.nodeDir({ galaxy: request.galaxy, node: request.node })
    try {
      await stat(target)
      throw new Error(`${request.galaxy}/${request.node} already exists.`)
    } catch (error) {
      if (!missing(error)) throw error
    }
    let source: NodeConfig
    if (request.source.type === 'selection') {
      this.validateSelection(request.source.selection)
      source = nodeConfigSchema.parse(
        await readJson(
          join(this.nodeDir(request.source.selection), 'versions', `${request.source.selection.version}.json`),
        ),
      )
    } else {
      assertItem(request.source.template, 'Template')
      source = nodeConfigSchema.parse(await readJson(join(this.templateDir(), `${request.source.template}.json`)))
    }
    const version = 'default'
    const config = { ...source, galaxy: Number(request.galaxy.slice(1)), node: request.node.replace(/_num$/i, '') }
    await atomicJson(join(target, 'versions', `${version}.json`), nodeConfigSchema.parse(config))
    await atomicJson(join(target, 'meta.json'), {
      default_version: version,
      versions: [{ id: version, name: versionName }],
    })
    return { node: request.node, version }
  }

  async createGalaxy(request: CreateGalaxyRequest): Promise<{ node: string; version: string; common: string }> {
    const target = this.galaxyPath(request.galaxy)
    assertItem(request.node, 'Initial Node')
    const versionName = assertName(request.versionName)
    this.validateSelection(request.source)
    try {
      await stat(target)
      throw new Error(`Galaxy ${request.galaxy} already exists.`)
    } catch (error) {
      if (!missing(error)) throw error
    }
    const existing = await this.catalog()
    if (existing.galaxies.some(galaxy => galaxy.id.toLowerCase() === request.galaxy.toLowerCase()))
      throw new Error(`Galaxy ${request.galaxy} already exists.`)
    const source = await this.load(request.source)
    const config = nodeConfigSchema.parse({
      ...source.node,
      galaxy: Number(request.galaxy.slice(1)),
      node: request.node.replace(/_num$/i, ''),
    })
    const common = commonConfigSchema.parse(source.common)
    const parent = join(this.dataRoot, 'galaxies')
    const temporary = join(parent, `.${request.galaxy}-${randomUUID()}.tmp`)
    await mkdir(temporary, { recursive: true })
    try {
      await atomicJson(join(temporary, 'common', 'versions', 'default.json'), common)
      await atomicJson(join(temporary, 'common', 'meta.json'), {
        default_profile: 'default',
        profiles: [{ id: 'default', name: '默认' }],
      })
      await atomicJson(join(temporary, 'nodes', request.node, 'versions', 'default.json'), config)
      await atomicJson(join(temporary, 'nodes', request.node, 'meta.json'), {
        default_version: 'default',
        versions: [{ id: 'default', name: versionName }],
      })
      await rename(temporary, target)
    } catch (error) {
      if (dirname(resolve(temporary)) !== resolve(parent)) throw error
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
    return { node: request.node, version: 'default', common: 'default' }
  }

  async stage(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }> {
    const data = await this.load(selection)
    await this.stageValues(selection, data.node, data.common)
    return data
  }

  async stageValues(selection: Selection, node: NodeConfig, common: CommonConfig): Promise<void> {
    this.validateSelection(selection)
    const parsedNode = nodeConfigSchema.parse(node)
    const parsedCommon = commonConfigSchema.parse(common)
    this.assertIdentity(selection, parsedNode)
    const target = join(this.mapRoot, selection.galaxy)
    // Materialize negative ship deltas for the existing BAT/Resolver, which accepts only nonnegative counts.
    const hasShipReduction = Object.values(parsedNode.player_state.ships).some(count => count < 0)
    const stagedNode = hasShipReduction
      ? {
          ...parsedNode,
          player_state: { ...parsedNode.player_state, ships: effectiveShipCounts(parsedNode, parsedCommon) },
        }
      : parsedNode
    const stagedCommon = { ...parsedCommon }
    if (hasShipReduction) delete stagedCommon.ships
    await atomicJson(join(target, `${selection.node}.json`), stagedNode)
    await atomicJson(join(target, 'common.json'), stagedCommon)
  }

  async readStagedNode(selection: Selection): Promise<NodeConfig> {
    this.validateSelection(selection)
    const node = nodeConfigSchema.parse(await readJson(join(this.mapRoot, selection.galaxy, `${selection.node}.json`)))
    this.assertIdentity(selection, node)
    return node
  }
}

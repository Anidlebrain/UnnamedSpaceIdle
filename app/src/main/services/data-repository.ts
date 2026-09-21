import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  commonConfigSchema,
  commonMetaSchema,
  nodeConfigSchema,
  templateMetaSchema,
  versionMetaSchema,
  type CommonConfig,
  type NodeConfig,
} from '../../shared/schemas'
import type { Catalog, CreateNodeRequest, ImportPreview, Selection } from '../../shared/contracts'

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

export class DataRepository {
  constructor(
    private readonly dataRoot: string,
    private readonly mapRoot: string,
  ) {}
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

  async stage(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }> {
    const data = await this.load(selection)
    const target = join(this.mapRoot, selection.galaxy)
    await atomicJson(join(target, `${selection.node}.json`), data.node)
    await atomicJson(join(target, 'common.json'), data.common)
    return data
  }

  async readStagedNode(selection: Selection): Promise<NodeConfig> {
    this.validateSelection(selection)
    const node = nodeConfigSchema.parse(await readJson(join(this.mapRoot, selection.galaxy, `${selection.node}.json`)))
    this.assertIdentity(selection, node)
    return node
  }
}

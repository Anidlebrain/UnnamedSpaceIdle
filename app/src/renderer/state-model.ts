import type { Catalog, SearchTaskSnapshot, Selection } from '../shared/contracts'
import type { CommonConfig, NodeConfig, OptimizerConfig, OptimizerResult } from '../shared/schemas'

export type Workspace = 'node' | 'common' | 'search' | 'rerun' | 'templates'
export type PageContexts = {
  node: Selection
  search: Selection
  templates: Selection
  common: Selection
  rerunGalaxy: string
}

export type Draft<T> = { value: T; source: string; savedSource: string }
export type SearchTaskState = {
  snapshot: SearchTaskSnapshot
  status: 'running' | 'completed' | 'failed'
  logs: string
  result?: OptimizerResult
  exitCode?: number
  finishedAt?: string
  error?: string
}

export const emptySelection: Selection = { galaxy: '', node: '', version: '', common: '' }
export const nodeDomainKey = ({ galaxy, node, version }: Selection) => `${galaxy}/${node}/${version}`
export const commonDomainKey = ({ galaxy, common }: Selection) => `${galaxy}/${common}`
export const formatJson = (value: unknown) => JSON.stringify(value, null, 2)
export const isDirty = <T>(draft?: Draft<T>) => Boolean(draft && draft.source !== draft.savedSource)

export function chooseInitial(catalog: Catalog): Selection {
  const galaxy = catalog.galaxies[0]
  const node = galaxy?.nodes[0]
  return {
    galaxy: galaxy?.id ?? '',
    node: node?.id ?? '',
    version: node?.defaultVersion ?? '',
    common: galaxy?.defaultCommon ?? '',
  }
}

export function initialContexts(catalog: Catalog, storedSearch: Selection | null): PageContexts {
  const initial = chooseInitial(catalog)
  return {
    node: { ...initial },
    search: { ...(storedSearch ?? initial) },
    templates: { ...initial },
    common: { ...initial },
    rerunGalaxy: initial.galaxy,
  }
}

export function updateSelection(
  catalog: Catalog,
  selection: Selection,
  field: keyof Selection,
  value: string,
): Selection {
  if (field === 'galaxy') {
    const galaxy = catalog.galaxies.find(item => item.id === value)
    const node = galaxy?.nodes[0]
    return {
      galaxy: value,
      node: node?.id ?? '',
      version: node?.defaultVersion ?? '',
      common: galaxy?.defaultCommon ?? '',
    }
  }
  if (field === 'node') {
    const galaxy = catalog.galaxies.find(item => item.id === selection.galaxy)
    const node = galaxy?.nodes.find(item => item.id === value)
    return { ...selection, node: value, version: node?.defaultVersion ?? '' }
  }
  return { ...selection, [field]: value }
}

export function nodeLocked(task: SearchTaskState | null, selection: Selection) {
  const source = task?.status === 'running' ? task.snapshot : null
  return Boolean(
    source &&
    source.galaxy === selection.galaxy &&
    source.node === selection.node &&
    source.version === selection.version,
  )
}

export function commonLocked(task: SearchTaskState | null, selection: Selection) {
  const source = task?.status === 'running' ? task.snapshot : null
  return Boolean(source && source.galaxy === selection.galaxy && source.common === selection.common)
}

export function taskFromSnapshot(snapshot: SearchTaskSnapshot): SearchTaskState {
  return { snapshot, status: 'running', logs: '' }
}

export type DraftMaps = {
  nodes: Record<string, Draft<NodeConfig>>
  searches: Record<string, Draft<NodeConfig>>
  commons: Record<string, Draft<CommonConfig>>
  optimizer?: Draft<OptimizerConfig>
}

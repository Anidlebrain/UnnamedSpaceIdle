import type { CommonConfig, NodeConfig, OptimizerResult } from './schemas'

export type ImportPreview = { galaxies: Array<{ id: string; nodes: string[]; common: boolean }> }
export type Selection = { galaxy: string; node: string; version: string; common: string }
export type NamedItem = { id: string; name: string; isDefault: boolean }
export type Catalog = {
  galaxies: Array<{
    id: string
    nodes: Array<{ id: string; versions: NamedItem[]; defaultVersion: string }>
    commons: NamedItem[]
    defaultCommon: string
  }>
  templates: Array<{ id: string; name: string }>
}
export type RunResult = {
  exitCode: number
  startedAt: string
  finishedAt: string
  result?: OptimizerResult
  error?: string
}
export type CopyResult = { exitCode: number; startedAt: string; finishedAt: string; node?: NodeConfig; error?: string }
export type CreateNodeRequest = {
  galaxy: string
  node: string
  versionName: string
  source: { type: 'selection'; selection: Selection } | { type: 'template'; template: string }
}
export type FleetManagerApi = {
  previewImport(): Promise<ImportPreview>
  importMap(): Promise<void>
  catalog(): Promise<Catalog>
  load(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }>
  save(selection: Selection, node: NodeConfig): Promise<void>
  saveCommon(selection: Selection, common: CommonConfig): Promise<void>
  createVersion(selection: Selection, name: string): Promise<string>
  renameVersion(selection: Selection, name: string): Promise<void>
  deleteVersion(selection: Selection): Promise<void>
  setDefaultVersion(selection: Selection): Promise<void>
  createCommon(selection: Selection, name: string): Promise<string>
  renameCommon(selection: Selection, name: string): Promise<void>
  deleteCommon(selection: Selection): Promise<void>
  setDefaultCommon(selection: Selection): Promise<void>
  createTemplate(selection: Selection, name: string): Promise<string>
  renameTemplate(id: string, name: string): Promise<void>
  deleteTemplate(id: string): Promise<void>
  createNode(request: CreateNodeRequest): Promise<{ node: string; version: string }>
  run(selection: Selection): Promise<RunResult>
  useBest(selection: Selection): Promise<CopyResult>
  onOutput(listener: (line: string) => void): () => void
}

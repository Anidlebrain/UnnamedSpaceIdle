import type { CommonConfig, NodeConfig, OptimizerConfig, OptimizerResult, SearchConfig } from './schemas'

export type ImportPreview = { galaxies: Array<{ id: string; nodes: string[]; common: boolean }> }
export type Selection = { galaxy: string; node: string; version: string; common: string }
export type ConfigSource = 'local' | 'default'
export type SearchTaskRequest = Selection & { versionName: string; commonName: string; search: SearchConfig }
export type SearchTaskSnapshot = SearchTaskRequest & {
  taskId: string
  formation_columns?: number
  nodeConfigHash: string
  stagedNodeConfigHash: string
  commonConfigHash: string
  optimizerConfigHash: string
  optimizerConfigVersion: string
  environment: Pick<NodeConfig, 'boss' | 'hazards' | 'supports'> & { player_state?: NodeConfig['player_state'] }
  startedAt: string
}
export type OptimizerOutput = { line: string; taskId?: string }
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
  task?: SearchTaskSnapshot
  result?: OptimizerResult
  error?: string
  canceled?: boolean
}
export type SearchQueueItem = {
  snapshot: SearchTaskSnapshot
  status: 'waiting' | 'running' | 'success' | 'failed' | 'canceled'
  runningAt?: string
  logs: string
  run?: RunResult
}
export type GalaxyRerunRequest = { galaxy: string; nodes: string[]; search: SearchConfig }
export type GalaxyRerunNode = {
  node: string
  version: string
  common: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  startedAt?: string
  finishedAt?: string
  changed?: boolean
  run?: RunResult
  error?: string
}
export type GalaxyRerunProgress = {
  galaxy: string
  search?: SearchConfig
  status: 'running' | 'completed' | 'canceled'
  total: number
  completed: number
  currentNode?: string
  startedAt: string
  finishedAt?: string
  nodes: GalaxyRerunNode[]
}
export type CopyResult = { exitCode: number; startedAt: string; finishedAt: string; node?: NodeConfig; error?: string }
export type CreateNodeRequest = {
  galaxy: string
  node: string
  versionName: string
  source: { type: 'selection'; selection: Selection } | { type: 'template'; template: string }
}
export type FleetManagerApi = {
  runtime?: 'desktop' | 'web'
  previewImport(): Promise<ImportPreview>
  importMap(): Promise<void>
  catalog(): Promise<Catalog>
  load(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }>
  loadOptimizerConfig(): Promise<OptimizerConfig>
  loadSearchConfig(): Promise<SearchConfig>
  configSources(): Promise<{ search: ConfigSource; optimizer: ConfigSource }>
  save(selection: Selection, node: NodeConfig): Promise<void>
  saveSearchConfig(search: SearchConfig): Promise<SearchConfig>
  saveCommon(selection: Selection, common: CommonConfig): Promise<void>
  saveOptimizerConfig(config: OptimizerConfig): Promise<void>
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
  run(request: SearchTaskRequest): Promise<RunResult>
  enqueueSearch(request: SearchTaskRequest): Promise<SearchQueueItem>
  searchQueue(): Promise<SearchQueueItem[]>
  stopCurrent(): Promise<void>
  stopAll(): Promise<void>
  rerunGalaxy(request: GalaxyRerunRequest | string): Promise<GalaxyRerunProgress>
  useBest(taskId: string): Promise<CopyResult>
  onOutput(listener: (output: OptimizerOutput) => void): () => void
  onSearchTask(listener: (task: SearchTaskSnapshot) => void): () => void
  onSearchQueue(listener: (queue: SearchQueueItem[]) => void): () => void
  onGalaxyProgress(listener: (progress: GalaxyRerunProgress) => void): () => void
}

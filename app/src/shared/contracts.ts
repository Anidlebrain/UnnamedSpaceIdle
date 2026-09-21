import type { CommonConfig, NodeConfig, OptimizerResult } from './schemas'

export type ImportPreview = { galaxies: Array<{ id: string; nodes: string[]; common: boolean }> }
export type Selection = { galaxy: string; node: string; version: string; common: string }
export type Catalog = { galaxies: Array<{ id: string; nodes: Array<{ id: string; versions: string[] }>; commons: string[] }> }
export type RunResult = { exitCode: number; startedAt: string; finishedAt: string; result?: OptimizerResult; error?: string }
export type FleetManagerApi = {
  previewImport(): Promise<ImportPreview>
  importMap(): Promise<void>
  catalog(): Promise<Catalog>
  load(selection: Selection): Promise<{ node: NodeConfig; common: CommonConfig }>
  save(selection: Selection, node: NodeConfig): Promise<void>
  run(selection: Selection): Promise<RunResult>
  onOutput(listener: (line: string) => void): () => void
}

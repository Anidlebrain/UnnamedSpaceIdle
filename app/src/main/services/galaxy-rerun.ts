import type { GalaxyRerunProgress, RunResult, Selection } from '../../shared/contracts'
import { hasFormationOrLoadoutChange } from '../../shared/formation-diff'
import { DataRepository } from './data-repository'
import { OptimizerRunner } from './optimizer-runner'

export class GalaxyRerunService {
  constructor(
    private readonly repo: DataRepository,
    private readonly runner: OptimizerRunner,
    private readonly emit: (progress: GalaxyRerunProgress) => void,
  ) {}

  async run(galaxy: string): Promise<GalaxyRerunProgress> {
    const selections = await this.repo.galaxyDefaultSelections(galaxy)
    const progress: GalaxyRerunProgress = {
      galaxy,
      status: 'running',
      total: selections.length,
      completed: 0,
      startedAt: new Date().toISOString(),
      nodes: selections.map(selection => ({
        node: selection.node,
        version: selection.version,
        common: selection.common,
        status: 'queued',
      })),
    }
    this.publish(progress)
    await this.runner.runQueue(
      selections,
      selection => {
        const node = this.node(progress, selection)
        node.status = 'running'
        node.startedAt = new Date().toISOString()
        progress.currentNode = selection.node
        this.publish(progress)
      },
      (selection, run) => {
        const node = this.node(progress, selection)
        node.run = run
        node.startedAt = run.startedAt
        node.finishedAt = run.finishedAt
        const validationError = this.resultError(run)
        if (validationError) {
          node.status = 'failed'
          node.error = validationError
          node.changed = undefined
          node.run = { ...run, result: undefined, error: validationError }
        } else {
          node.status = 'succeeded'
          node.changed = hasFormationOrLoadoutChange(run.result!.verified_baseline, run.result!.best_result)
        }
        progress.completed++
        this.publish(progress)
      },
    )
    progress.status = 'completed'
    progress.currentNode = undefined
    progress.finishedAt = new Date().toISOString()
    this.publish(progress)
    return structuredClone(progress)
  }

  private resultError(run: RunResult): string | undefined {
    if (run.error) return run.error
    if (!run.result?.verified_baseline) return '本次结果缺少 verified_baseline，无法判定配置变化。'
    if (!run.result.best_result) return '本次结果缺少 best_result，无法判定配置变化。'
    return undefined
  }

  private node(progress: GalaxyRerunProgress, selection: Selection) {
    return progress.nodes.find(item => item.node === selection.node)!
  }

  private publish(progress: GalaxyRerunProgress) {
    this.emit(structuredClone(progress))
  }
}

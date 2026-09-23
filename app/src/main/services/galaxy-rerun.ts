import type { GalaxyRerunProgress, GalaxyRerunRequest, RunResult, Selection } from '../../shared/contracts'
import { hasFormationOrLoadoutChange } from '../../shared/formation-diff'
import { DataRepository } from './data-repository'
import { OptimizerRunner } from './optimizer-runner'

export class GalaxyRerunService {
  constructor(
    private readonly repo: DataRepository,
    private readonly runner: OptimizerRunner,
    private readonly emit: (progress: GalaxyRerunProgress) => void,
  ) {}

  async run(input: GalaxyRerunRequest | string): Promise<GalaxyRerunProgress> {
    const request =
      typeof input === 'string' ? { galaxy: input, nodes: [], search: await this.repo.loadSearchConfig() } : input
    const { galaxy } = request
    const savedSearch = await this.repo.saveSearchConfig(request.search)
    const defaults = await this.repo.galaxyDefaultSelections(galaxy)
    const selections = (request.nodes.length ? request.nodes : defaults.map(item => item.node)).map(node => {
      const selection = defaults.find(item => item.node === node)
      if (!selection) throw new Error(`节点 ${node} 不在 ${galaxy} 中。`)
      return selection
    })
    if (!selections.length || new Set(selections.map(item => item.node)).size !== selections.length)
      throw new Error('请选择不重复的重跑节点。')
    const progress: GalaxyRerunProgress = {
      galaxy,
      search: structuredClone(savedSearch),
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
          node.status = run.canceled ? 'canceled' : 'failed'
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
      savedSearch,
    )
    for (const node of progress.nodes) if (node.status === 'queued') node.status = 'canceled'
    progress.status = progress.nodes.some(node => node.status === 'canceled') ? 'canceled' : 'completed'
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

import { createHash, randomUUID } from 'node:crypto'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { optimizerResultSchema, type OptimizerResult } from '../../shared/schemas'
import { effectiveShipCounts } from '../../shared/ship-counts'
import type { SearchConfig } from '../../shared/schemas'
import type {
  CopyResult,
  RunResult,
  SearchQueueItem,
  SearchTaskRequest,
  SearchTaskSnapshot,
  Selection,
} from '../../shared/contracts'
import { DataRepository } from './data-repository'

export class OptimizerRunner {
  private running = false
  private activeTask?: SearchTaskSnapshot
  private pendingSelection?: Selection
  private queuedSelections: Selection[] = []
  private lastSearch?: RunResult
  private completed = new Map<string, RunResult>()
  private latestResultByNode = new Map<string, string>()
  private queue: SearchQueueItem[] = []
  private pendingEnqueues = new Set<string>()
  private lastOutputPublishAt = 0
  private prepared = new Map<
    string,
    {
      node: Awaited<ReturnType<DataRepository['load']>>['node']
      common: Awaited<ReturnType<DataRepository['load']>>['common']
    }
  >()
  private process?: ChildProcess
  private recentOutput = ''
  private cancelCurrent = false
  private cancelRemaining = false
  constructor(
    private readonly repo: DataRepository,
    private readonly optimizerRoot: string,
    private readonly emit: (line: string, taskId?: string) => void,
    private readonly executor?: (selection: Selection, mode: 'search' | 'copy') => Promise<number>,
    private readonly onTask?: (task: SearchTaskSnapshot) => void,
    private readonly onQueue?: (queue: SearchQueueItem[]) => void,
  ) {}
  getQueue(): SearchQueueItem[] {
    return structuredClone(this.queue)
  }
  async enqueue(request: SearchTaskRequest): Promise<SearchQueueItem> {
    const selection: Selection = request
    const targetKey = this.taskKey(selection)
    if (
      this.pendingEnqueues.has(targetKey) ||
      this.queue.some(item => this.taskKey(item.snapshot) === targetKey && ['waiting', 'running'].includes(item.status))
    )
      throw new Error('该 Node / Version 已在等待或搜索中。')
    this.pendingEnqueues.add(targetKey)
    try {
      const search = await this.repo.saveSearchConfig(request.search)
      const values = await this.repo.configHashes(selection)
      if (
        this.queue.some(
          item => this.taskKey(item.snapshot) === targetKey && ['waiting', 'running'].includes(item.status),
        )
      )
        throw new Error('该 Node / Version 已在等待或搜索中。')
      const node = { ...values.node, search: structuredClone(search) }
      const snapshot: SearchTaskSnapshot = {
        ...selection,
        formation_columns: node.formation_columns,
        versionName: request.versionName,
        commonName: request.commonName,
        search: structuredClone(search),
        taskId: randomUUID(),
        nodeConfigHash: values.nodeConfigHash,
        stagedNodeConfigHash: this.hash(node),
        commonConfigHash: values.commonConfigHash,
        optimizerConfigHash: values.optimizerConfigHash,
        optimizerConfigVersion: `sha256:${values.optimizerConfigHash}`,
        environment: {
          boss: structuredClone(node.boss),
          hazards: structuredClone(node.hazards),
          supports: structuredClone(node.supports),
          player_state: {
            ...structuredClone(node.player_state),
            ships: effectiveShipCounts(node, values.common),
          },
        },
        startedAt: new Date().toISOString(),
      }
      const item: SearchQueueItem = { snapshot, status: 'waiting', logs: '' }
      this.queue = this.queue.filter(entry => {
        if (this.taskKey(entry.snapshot) !== targetKey) return true
        this.completed.delete(entry.snapshot.taskId)
        return false
      })
      while (this.queue.length >= 100) {
        const index = this.queue.findIndex(entry => ['success', 'failed', 'canceled'].includes(entry.status))
        if (index < 0) break
        const [removed] = this.queue.splice(index, 1)
        this.completed.delete(removed.snapshot.taskId)
      }
      this.prepared.set(snapshot.taskId, { node, common: values.common })
      this.queue.push(item)
      this.publishQueue()
      void this.drainQueue()
      return structuredClone(item)
    } finally {
      this.pendingEnqueues.delete(targetKey)
    }
  }
  private taskKey(selection: Selection): string {
    return `${selection.galaxy}/${selection.node}/${selection.version}`
  }
  private async drainQueue(): Promise<void> {
    if (this.running) return
    const item = this.queue.find(entry => entry.status === 'waiting')
    if (!item) return
    this.acquire()
    const task = item.snapshot
    this.latestResultByNode.delete(this.resultKey(task))
    const staged = this.prepared.get(task.taskId)!
    item.status = 'running'
    item.runningAt = new Date().toISOString()
    this.activeTask = task
    this.cancelCurrent = false
    this.publishQueue()
    this.onTask?.(task)
    try {
      if (this.hash(await this.repo.loadOptimizerConfig()) !== task.optimizerConfigHash)
        throw new Error('Optimizer 公共配置在排队后已变化，请重新加入任务。')
      await this.repo.stageValues(task, staged.node, staged.common)
      const result = await this.runUnlocked(task, task, staged)
      item.run = this.cancelCurrent
        ? { ...result, startedAt: item.runningAt, canceled: true, error: '搜索被用户中止' }
        : { ...result, startedAt: item.runningAt }
      item.status = item.run.canceled ? 'canceled' : item.run.error ? 'failed' : 'success'
      if (item.status === 'success') {
        this.lastSearch = item.run
        this.completed.set(task.taskId, item.run)
        this.latestResultByNode.set(this.resultKey(task), task.taskId)
      }
    } catch (error) {
      const now = new Date().toISOString()
      item.run = {
        exitCode: -1,
        startedAt: item.runningAt,
        finishedAt: now,
        task,
        error: this.cancelCurrent ? '搜索被用户中止' : (error as Error).message,
        canceled: this.cancelCurrent,
      }
      item.status = this.cancelCurrent ? 'canceled' : 'failed'
    } finally {
      this.prepared.delete(task.taskId)
      this.activeTask = undefined
      this.running = false
      this.cancelCurrent = false
      this.publishQueue()
      void this.drainQueue()
    }
  }
  async stopCurrentTask(): Promise<void> {
    if (!this.running) return
    this.cancelCurrent = true
    if (this.process?.pid) await this.killTree(this.process.pid)
  }
  async stopAllTasks(): Promise<void> {
    this.cancelRemaining = true
    for (const item of this.queue)
      if (item.status === 'waiting') {
        item.status = 'canceled'
        item.run = {
          exitCode: -1,
          startedAt: item.snapshot.startedAt,
          finishedAt: new Date().toISOString(),
          task: item.snapshot,
          canceled: true,
          error: '搜索被用户中止',
        }
        this.prepared.delete(item.snapshot.taskId)
      }
    this.publishQueue()
    await this.stopCurrentTask()
  }
  private publishQueue() {
    this.onQueue?.(this.getQueue())
  }
  private resultKey(selection: Selection) {
    return `${selection.galaxy}/${selection.node.replace(/_num$/i, '')}`
  }
  private async killTree(pid: number): Promise<void> {
    if (process.platform !== 'win32') {
      this.process?.kill('SIGKILL')
      return
    }
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  }
  async run(request: SearchTaskRequest | Selection): Promise<RunResult> {
    this.acquire()
    try {
      const selection: Selection = {
        galaxy: request.galaxy,
        node: request.node,
        version: request.version,
        common: request.common,
      }
      this.pendingSelection = selection
      const savedSearch =
        'search' in request ? await this.repo.saveSearchConfig(request.search) : await this.repo.loadSearchConfig()
      const prepared = await this.repo.configHashes(selection)
      const stagedNode = { ...prepared.node, search: structuredClone(savedSearch) }
      const task: SearchTaskSnapshot = {
        ...selection,
        formation_columns: stagedNode.formation_columns,
        versionName: 'versionName' in request ? request.versionName : request.version,
        commonName: 'commonName' in request ? request.commonName : request.common,
        search: structuredClone(savedSearch),
        taskId: randomUUID(),
        nodeConfigHash: prepared.nodeConfigHash,
        stagedNodeConfigHash: this.hash(stagedNode),
        commonConfigHash: prepared.commonConfigHash,
        optimizerConfigHash: prepared.optimizerConfigHash,
        optimizerConfigVersion: `sha256:${prepared.optimizerConfigHash}`,
        environment: {
          boss: structuredClone(stagedNode.boss),
          hazards: structuredClone(stagedNode.hazards),
          supports: structuredClone(stagedNode.supports),
          player_state: {
            ...structuredClone(stagedNode.player_state),
            ships: effectiveShipCounts(stagedNode, prepared.common),
          },
        },
        startedAt: new Date().toISOString(),
      }
      this.activeTask = task
      this.pendingSelection = undefined
      this.onTask?.(task)
      await this.repo.stageValues(selection, stagedNode, prepared.common)
      const result = await this.runUnlocked(selection, task, { node: stagedNode, common: prepared.common })
      this.lastSearch = result
      if (!result.error) this.latestResultByNode.set(this.resultKey(selection), task.taskId)
      return result
    } finally {
      this.activeTask = undefined
      this.pendingSelection = undefined
      this.running = false
    }
  }
  async runQueue(
    selections: Selection[],
    onStart: (selection: Selection) => void,
    onComplete: (selection: Selection, result: RunResult) => void,
    requestedSearch?: SearchConfig,
  ): Promise<RunResult[]> {
    this.acquire()
    this.queuedSelections = selections.map(selection => ({ ...selection }))
    this.cancelRemaining = false
    const results: RunResult[] = []
    try {
      const search = requestedSearch
        ? await this.repo.saveSearchConfig(requestedSearch)
        : await this.repo.loadSearchConfig()
      const optimizerHash = this.hash(await this.repo.loadOptimizerConfig())
      for (const selection of selections) {
        if (this.cancelRemaining) break
        onStart(selection)
        const priorResult = this.latestResultByNode.get(this.resultKey(selection))
        if (priorResult) this.completed.delete(priorResult)
        this.latestResultByNode.delete(this.resultKey(selection))
        let result: RunResult
        try {
          const prepared = await this.repo.configHashes(selection)
          if (prepared.optimizerConfigHash !== optimizerHash)
            throw new Error('Optimizer 公共配置在批次运行期间已变化，未继续使用旧快照。')
          const stagedNode = { ...prepared.node, search: structuredClone(search) }
          const task: SearchTaskSnapshot = {
            ...selection,
            formation_columns: stagedNode.formation_columns,
            versionName: selection.version,
            commonName: selection.common,
            search: structuredClone(search),
            taskId: randomUUID(),
            nodeConfigHash: prepared.nodeConfigHash,
            stagedNodeConfigHash: this.hash(stagedNode),
            commonConfigHash: prepared.commonConfigHash,
            optimizerConfigHash: prepared.optimizerConfigHash,
            optimizerConfigVersion: `sha256:${prepared.optimizerConfigHash}`,
            environment: {
              boss: structuredClone(stagedNode.boss),
              hazards: structuredClone(stagedNode.hazards),
              supports: structuredClone(stagedNode.supports),
              player_state: {
                ...structuredClone(stagedNode.player_state),
                ships: effectiveShipCounts(stagedNode, prepared.common),
              },
            },
            startedAt: new Date().toISOString(),
          }
          this.activeTask = task
          await this.repo.stageValues(selection, stagedNode, prepared.common)
          result = await this.runUnlocked(selection, task, { node: stagedNode, common: prepared.common })
          if (!result.error && result.result?.best_result) {
            this.completed.set(task.taskId, result)
            this.latestResultByNode.set(this.resultKey(selection), task.taskId)
          }
        } catch (error) {
          const time = new Date().toISOString()
          result = { exitCode: -1, startedAt: time, finishedAt: time, error: (error as Error).message }
        }
        if (this.cancelCurrent) result = { ...result, canceled: true, error: '搜索被用户中止' }
        results.push(result)
        onComplete(selection, result)
        this.activeTask = undefined
        this.cancelCurrent = false
      }
      return results
    } finally {
      this.activeTask = undefined
      this.queuedSelections = []
      this.running = false
      void this.drainQueue()
    }
  }
  async useBest(taskId: string): Promise<CopyResult> {
    this.acquire()
    const startedAt = new Date().toISOString()
    try {
      const completed = this.completed.get(taskId) ?? this.lastSearch
      if (!completed?.task || completed.task.taskId !== taskId || completed.error || !completed.result?.best_result)
        return {
          exitCode: -1,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: 'The selected Best Found is not the most recent successful search task.',
        }
      const selection: Selection = completed.task
      const latest = this.latestResultByNode.get(this.resultKey(selection))
      if (latest !== taskId)
        return {
          exitCode: -1,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: '该节点的结果文件已被后续搜索覆盖，请重新搜索后再应用。',
        }
      if ((await this.repo.nodeHash(selection)) !== completed.task.nodeConfigHash)
        return {
          exitCode: -1,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: 'Target Version changed after this search. Best Found was not applied.',
        }
      await this.repo.stage(selection)
      this.emit(`Staged ${selection.galaxy}/${selection.node} for Best Found copy.\n`, taskId)
      const exitCode = await (this.executor ? this.executor(selection, 'copy') : this.execute(selection, 'copy'))
      if (exitCode !== 0)
        return {
          exitCode,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: `Optimizer copy exited with code ${exitCode}; Manager data was not changed.`,
        }
      let node
      try {
        node = await this.repo.readStagedNode(selection)
      } catch (error) {
        return {
          exitCode,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: `Copied Node JSON is invalid; Manager data was not changed: ${(error as Error).message}`,
        }
      }
      await this.repo.save(selection, node)
      return { exitCode, startedAt, finishedAt: new Date().toISOString(), node }
    } finally {
      this.running = false
    }
  }
  private acquire() {
    if (this.running)
      throw new Error('An Optimizer task is already running. Wait for it to finish before starting another task.')
    this.running = true
  }
  assertNodeWritable(selection: Selection) {
    const source = this.activeTask ?? this.pendingSelection
    if (
      source &&
      source.galaxy === selection.galaxy &&
      source.node === selection.node &&
      source.version === selection.version
    )
      throw new Error(`This Version is being used by the ${source.node} search task. Edit it after the task finishes.`)
    if (
      this.queuedSelections.some(
        item => item.galaxy === selection.galaxy && item.node === selection.node && item.version === selection.version,
      )
    )
      throw new Error(`This Version is queued for the active Galaxy rerun. Edit it after the batch finishes.`)
    if (
      this.queue.some(
        item =>
          ['waiting', 'running'].includes(item.status) &&
          item.snapshot.galaxy === selection.galaxy &&
          item.snapshot.node === selection.node &&
          item.snapshot.version === selection.version,
      )
    )
      throw new Error('该版本正在搜索队列中，请等待任务完成。')
  }
  assertCommonWritable(selection: Selection) {
    const source = this.activeTask ?? this.pendingSelection
    if (source && source.galaxy === selection.galaxy && source.common === selection.common)
      throw new Error(`This Common is being used by the ${source.node} search task. Edit it after the task finishes.`)
    if (this.queuedSelections.some(item => item.galaxy === selection.galaxy && item.common === selection.common))
      throw new Error(`This Common is queued for the active Galaxy rerun. Edit it after the batch finishes.`)
    if (
      this.queue.some(
        item =>
          ['waiting', 'running'].includes(item.status) &&
          item.snapshot.galaxy === selection.galaxy &&
          item.snapshot.common === selection.common,
      )
    )
      throw new Error('该公共配置正在搜索队列中，请等待任务完成。')
  }
  assertOptimizerWritable() {
    if (this.running) {
      const source = this.activeTask ?? this.pendingSelection
      throw new Error(
        source
          ? `Optimizer Public is being used by the ${source.node} search task. Edit it after the task finishes.`
          : 'Optimizer Public is being used by the active Galaxy rerun. Edit it after the batch finishes.',
      )
    }
  }
  private async runUnlocked(
    selection: Selection,
    task: SearchTaskSnapshot,
    staged: {
      node: Awaited<ReturnType<DataRepository['load']>>['node']
      common: Awaited<ReturnType<DataRepository['load']>>['common']
    },
  ): Promise<RunResult> {
    const startedAt = task?.startedAt ?? new Date().toISOString()
    const map = join(this.optimizerRoot, 'map', selection.galaxy)
    const resultPath = join(map, `${selection.node.replace(/_num$/i, '')}.result.json`)
    const before = await this.snapshot(resultPath)
    const nodeHash = this.hash(staged.node)
    const commonHash = this.hash(staged.common)
    await this.taskSnapshot(selection, task, startedAt, nodeHash, commonHash, before)
    this.emit(
      `Staged ${selection.galaxy}/${selection.node}; node ${nodeHash.slice(0, 12)}, common ${commonHash.slice(0, 12)}\n`,
      task.taskId,
    )
    if (this.cancelCurrent)
      return {
        exitCode: -1,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: '搜索被用户中止',
        canceled: true,
      }
    const exitCode = await (this.executor ? this.executor(selection, 'search') : this.execute(selection, 'search'))
    if (this.cancelCurrent)
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: '搜索被用户中止',
        canceled: true,
      }
    if (exitCode !== 0)
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: `Optimizer exited with code ${exitCode}. ${this.recentOutput.slice(-1800)}`.trim(),
      }
    const after = await this.snapshot(resultPath)
    if (!after || (before !== undefined && after.mtimeMs <= before.mtimeMs))
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: 'Optimizer exited successfully but did not create changed result content for this task.',
      }
    let result: OptimizerResult
    try {
      result = optimizerResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')))
    } catch (error) {
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: `New result is invalid: ${(error as Error).message}`,
      }
    }
    const base = result.base_config as
      { resolver?: { friendly_input?: { galaxy?: number; node?: string } } } | undefined
    const identity = base?.resolver?.friendly_input
    if (
      identity &&
      (identity.galaxy !== Number(selection.galaxy.slice(1)) ||
        identity.node?.toLowerCase() !== selection.node.replace(/_num$/i, '').toLowerCase())
    )
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: 'New result identity does not match selected Galaxy / Node.',
      }
    return { exitCode, startedAt, finishedAt: new Date().toISOString(), task, result }
  }
  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }
  private async snapshot(path: string): Promise<{ mtimeMs: number; size: number; hash: string } | undefined> {
    try {
      const value = await stat(path)
      return {
        mtimeMs: value.mtimeMs,
        size: value.size,
        hash: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      }
    } catch {
      return undefined
    }
  }
  private async taskSnapshot(
    selection: Selection,
    task: SearchTaskSnapshot | undefined,
    startedAt: string,
    nodeHash: string,
    commonHash: string,
    before: unknown,
  ) {
    const path = join(this.optimizerRoot, '..', 'app', 'runtime', 'last-task.json')
    await mkdir(join(this.optimizerRoot, '..', 'app', 'runtime'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify(
        task
          ? { ...task, resultBefore: before }
          : { ...selection, nodeConfigHash: nodeHash, commonConfigHash: commonHash, startedAt, resultBefore: before },
        null,
        2,
      ),
    )
  }
  private execute(selection: Selection, mode: 'search' | 'copy'): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = ['/d', '/s', '/c', 'run_optimizer.bat', selection.galaxy, selection.node]
      if (mode === 'copy') args.push('--c')
      const process = spawn('cmd.exe', args, { cwd: this.optimizerRoot, windowsHide: true })
      this.recentOutput = ''
      this.process = process
      const output = (data: Buffer) => {
        const line = data.toString()
        this.recentOutput = (this.recentOutput + line).slice(-4000)
        const item = this.queue.find(entry => entry.snapshot.taskId === this.activeTask?.taskId)
        if (item) {
          item.logs = (item.logs + line).slice(-200_000)
          if (Date.now() - this.lastOutputPublishAt > 500) {
            this.lastOutputPublishAt = Date.now()
            this.publishQueue()
          }
        }
        this.emit(line, this.activeTask?.taskId)
      }
      process.stdout.on('data', output)
      process.stderr.on('data', output)
      process.on('error', reject)
      process.on('close', code => {
        this.process = undefined
        resolve(code ?? 1)
      })
    })
  }
}

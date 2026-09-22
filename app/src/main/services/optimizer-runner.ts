import { createHash, randomUUID } from 'node:crypto'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { optimizerResultSchema, type OptimizerResult } from '../../shared/schemas'
import type { CopyResult, RunResult, SearchTaskRequest, SearchTaskSnapshot, Selection } from '../../shared/contracts'
import { DataRepository } from './data-repository'

export class OptimizerRunner {
  private running = false
  private activeTask?: SearchTaskSnapshot
  private pendingSelection?: Selection
  private lastSearch?: RunResult
  constructor(
    private readonly repo: DataRepository,
    private readonly optimizerRoot: string,
    private readonly emit: (line: string, taskId?: string) => void,
    private readonly executor?: (selection: Selection, mode: 'search' | 'copy') => Promise<number>,
    private readonly onTask?: (task: SearchTaskSnapshot) => void,
  ) {}
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
      const prepared = await this.repo.configHashes(selection)
      const task: SearchTaskSnapshot = {
        ...request,
        versionName: 'versionName' in request ? request.versionName : request.version,
        commonName: 'commonName' in request ? request.commonName : request.common,
        taskId: randomUUID(),
        nodeConfigHash: prepared.nodeConfigHash,
        commonConfigHash: prepared.commonConfigHash,
        optimizerConfigHash: prepared.optimizerConfigHash,
        optimizerConfigVersion: `sha256:${prepared.optimizerConfigHash}`,
        search: structuredClone(prepared.node.search),
        startedAt: new Date().toISOString(),
      }
      this.activeTask = task
      this.pendingSelection = undefined
      this.onTask?.(task)
      await this.repo.stageValues(selection, prepared.node, prepared.common)
      const result = await this.runUnlocked(selection, task)
      this.lastSearch = result
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
  ): Promise<RunResult[]> {
    this.acquire()
    const results: RunResult[] = []
    try {
      for (const selection of selections) {
        onStart(selection)
        let result: RunResult
        try {
          result = await this.runUnlocked(selection)
        } catch (error) {
          const time = new Date().toISOString()
          result = { exitCode: -1, startedAt: time, finishedAt: time, error: (error as Error).message }
        }
        results.push(result)
        onComplete(selection, result)
      }
      return results
    } finally {
      this.running = false
    }
  }
  async useBest(taskId: string): Promise<CopyResult> {
    this.acquire()
    const startedAt = new Date().toISOString()
    try {
      const completed = this.lastSearch
      if (!completed?.task || completed.task.taskId !== taskId || completed.error || !completed.result?.best_result)
        return {
          exitCode: -1,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: 'The selected Best Found is not the most recent successful search task.',
        }
      const selection: Selection = completed.task
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
  }
  assertCommonWritable(selection: Selection) {
    const source = this.activeTask ?? this.pendingSelection
    if (source && source.galaxy === selection.galaxy && source.common === selection.common)
      throw new Error(`This Common is being used by the ${source.node} search task. Edit it after the task finishes.`)
  }
  assertOptimizerWritable() {
    const source = this.activeTask ?? this.pendingSelection
    if (source)
      throw new Error(
        `Optimizer Public is being used by the ${source.node} search task. Edit it after the task finishes.`,
      )
  }
  private async runUnlocked(selection: Selection, task?: SearchTaskSnapshot): Promise<RunResult> {
    const startedAt = task?.startedAt ?? new Date().toISOString()
    const map = join(this.optimizerRoot, 'map', selection.galaxy)
    const resultPath = join(map, `${selection.node.replace(/_num$/i, '')}.result.json`)
    const staged = task ? await this.repo.load(selection) : await this.repo.stage(selection)
    const before = await this.snapshot(resultPath)
    const nodeHash = this.hash(staged.node)
    const commonHash = this.hash(staged.common)
    await this.taskSnapshot(selection, task, startedAt, nodeHash, commonHash, before)
    this.emit(
      `Staged ${selection.galaxy}/${selection.node}; node ${nodeHash.slice(0, 12)}, common ${commonHash.slice(0, 12)}\n`,
      task?.taskId,
    )
    const exitCode = await (this.executor ? this.executor(selection, 'search') : this.execute(selection, 'search'))
    if (exitCode !== 0)
      return {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        task,
        error: `Optimizer exited with code ${exitCode}.`,
      }
    const after = await this.snapshot(resultPath)
    if (!after || (before !== undefined && (after.mtimeMs <= before.mtimeMs || after.hash === before.hash)))
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
      process.stdout.on('data', data => this.emit(data.toString(), this.activeTask?.taskId))
      process.stderr.on('data', data => this.emit(data.toString(), this.activeTask?.taskId))
      process.on('error', reject)
      process.on('close', code => resolve(code ?? 1))
    })
  }
}

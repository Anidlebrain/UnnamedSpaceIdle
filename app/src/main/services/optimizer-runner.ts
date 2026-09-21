import { createHash } from 'node:crypto'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { optimizerResultSchema, type OptimizerResult } from '../../shared/schemas'
import type { CopyResult, RunResult, Selection } from '../../shared/contracts'
import { DataRepository } from './data-repository'

export class OptimizerRunner {
  private running = false
  constructor(
    private readonly repo: DataRepository,
    private readonly optimizerRoot: string,
    private readonly emit: (line: string) => void,
    private readonly executor?: (selection: Selection, mode: 'search' | 'copy') => Promise<number>,
  ) {}
  async run(selection: Selection): Promise<RunResult> {
    if (this.running)
      throw new Error('An Optimizer task is already running. Wait for it to finish before starting another task.')
    this.running = true
    const startedAt = new Date().toISOString()
    const map = join(this.optimizerRoot, 'map', selection.galaxy)
    const resultPath = join(map, `${selection.node.replace(/_num$/i, '')}.result.json`)
    try {
      const staged = await this.repo.stage(selection)
      const before = await this.snapshot(resultPath)
      const nodeHash = this.hash(staged.node)
      const commonHash = this.hash(staged.common)
      await this.taskSnapshot(selection, startedAt, nodeHash, commonHash, before)
      this.emit(
        `Staged ${selection.galaxy}/${selection.node}; node ${nodeHash.slice(0, 12)}, common ${commonHash.slice(0, 12)}\n`,
      )
      const exitCode = await (this.executor ? this.executor(selection, 'search') : this.execute(selection, 'search'))
      if (exitCode !== 0)
        return {
          exitCode,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: `Optimizer exited with code ${exitCode}.`,
        }
      const after = await this.snapshot(resultPath)
      if (!after || (before !== undefined && (after.mtimeMs <= before.mtimeMs || after.hash === before.hash)))
        return {
          exitCode,
          startedAt,
          finishedAt: new Date().toISOString(),
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
          error: `New result is invalid: ${(error as Error).message}`,
        }
      }
      const base = result.base_config as
        { resolver?: { friendly_input?: { galaxy?: number; node?: string } } } | undefined
      const identity = base?.resolver?.friendly_input
      if (
        identity &&
        (identity.galaxy !== Number(selection.galaxy.slice(1)) ||
          identity.node?.toLowerCase() !== selection.node.toLowerCase())
      )
        return {
          exitCode,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: 'New result identity does not match selected Galaxy / Node.',
        }
      return { exitCode, startedAt, finishedAt: new Date().toISOString(), result }
    } finally {
      this.running = false
    }
  }
  async useBest(selection: Selection): Promise<CopyResult> {
    if (this.running)
      throw new Error('An Optimizer task is already running. Wait for it to finish before starting another task.')
    this.running = true
    const startedAt = new Date().toISOString()
    try {
      await this.repo.stage(selection)
      this.emit(`Staged ${selection.galaxy}/${selection.node} for Best Found copy.\n`)
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
        { ...selection, nodeConfigHash: nodeHash, commonConfigHash: commonHash, startedAt, resultBefore: before },
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
      process.stdout.on('data', data => this.emit(data.toString()))
      process.stderr.on('data', data => this.emit(data.toString()))
      process.on('error', reject)
      process.on('close', code => resolve(code ?? 1))
    })
  }
}

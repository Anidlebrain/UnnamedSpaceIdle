import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULT_TITAN_SETTINGS,
  titanCandidateSchema,
  titanPlayerSchema,
  titanSettingsSchema,
  type TitanInspection,
  type TitanLayer,
  type TitanPlayer,
  type TitanRequest,
  type TitanResult,
  type TitanSettings,
  type TitanTask,
  type TitanWorkspace,
} from '../../shared/titan'

export type TitanExecutor = (args: string[], output: (text: string) => void) => Promise<number>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function readOptional(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}
async function atomicJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, json(value), 'utf8')
  await rename(temporary, path)
}
export class TitanService {
  private task: TitanTask | null = null
  private process?: ChildProcess
  private busy = false
  constructor(
    private readonly dataRoot: string,
    private readonly titanRoot: string,
    private readonly emit: (task: TitanTask) => void = () => {},
    private readonly executor?: TitanExecutor,
    private readonly terminate?: () => Promise<void>,
  ) {}
  private get folder() {
    return join(this.dataRoot, 'titan')
  }
  private publish() {
    if (this.task) this.emit(structuredClone(this.task))
  }
  current() {
    return this.task ? structuredClone(this.task) : null
  }
  async load(): Promise<TitanWorkspace> {
    const settingsData = await readOptional(join(this.folder, 'settings.json'))
    const settings = settingsData
      ? titanSettingsSchema.parse(settingsData)
      : { ...DEFAULT_TITAN_SETTINGS, godotPath: await this.detectGodot() }
    const managerPath = join(this.folder, 'player.json')
    const localPath = join(this.titanRoot, 'local', 'player.json')
    try {
      const manager = await readOptional(managerPath)
      if (manager !== undefined) return { player: titanPlayerSchema.parse(manager), settings, playerSource: 'manager' }
      const local = await readOptional(localPath)
      if (local !== undefined) return { player: titanPlayerSchema.parse(local), settings, playerSource: 'local' }
      return { player: null, settings, playerSource: 'none' }
    } catch (error) {
      return { player: null, settings, playerSource: 'none', importError: String(error) }
    }
  }
  private async detectGodot() {
    try {
      const bat = await readFile(join(this.titanRoot, '..', 'fleetSimulation', 'run_optimizer.bat'), 'utf8')
      const dir = /set "GODOT_DIR=([^"\r\n]+)"/i.exec(bat)?.[1]
      const executable = /set "GODOT_EXE=%GODOT_DIR%\\([^"\r\n]+)"/i.exec(bat)?.[1]
      if (dir && executable) {
        const path = join(dir, executable)
        await access(path)
        return path
      }
    } catch {
      /* An absent runner path is edited in the Titan settings. */
    }
    return ''
  }
  async savePlayer(value: TitanPlayer) {
    const player = titanPlayerSchema.parse(value)
    await mkdir(this.folder, { recursive: true })
    await atomicJson(join(this.folder, 'player.json'), player)
    return player
  }
  async saveSettings(value: TitanSettings) {
    const settings = titanSettingsSchema.parse(value)
    await mkdir(this.folder, { recursive: true })
    await atomicJson(join(this.folder, 'settings.json'), settings)
    return settings
  }
  async inspect(request: { sector: string; layer: TitanLayer; source?: string }): Promise<TitanInspection> {
    const settings = titanSettingsSchema.parse({
      ...DEFAULT_TITAN_SETTINGS,
      sector: request.sector,
      layer: request.layer,
      sourcePath: request.source ?? '',
    })
    const args = ['inspect', '--sector', settings.sector, '--layer', settings.layer]
    if (settings.sourcePath) args.push('--source', settings.sourcePath)
    let text = ''
    const code = await this.execute(
      args,
      chunk => {
        text += chunk
      },
      false,
    )
    if (code !== 0) throw new Error(text.trim() || `泰坦区域读取失败（退出码 ${code}）。`)
    const data = JSON.parse(text.replace(/^\uFEFF/, '').trim()) as TitanInspection
    if (
      data.status !== 'RESEARCH_ONLY' ||
      !data.region?.sector_id ||
      data.region.layer !== settings.layer ||
      !data.cores ||
      !data.milestones ||
      !data.array_elements
    )
      throw new Error('泰坦区域资料结构或身份无效。')
    return data
  }
  async start(value: TitanRequest): Promise<TitanTask> {
    if (this.busy) throw new Error('泰坦搜索正在运行，请先停止当前任务。')
    const request = {
      player: titanPlayerSchema.parse(value.player),
      settings: titanSettingsSchema.parse(value.settings),
    }
    if (!request.settings.godotPath) throw new Error('请先设置 Godot 可执行文件路径。')
    this.busy = true
    try {
      const report = await this.inspect({
        sector: request.settings.sector,
        layer: request.settings.layer,
        source: request.settings.sourcePath,
      })
      if (report.game_version !== (request.player.statistics.game_version ?? '0.85.1.0'))
        throw new Error('统计读数版本与恢复工程不一致，请重新采集当前版本读数，不能只修改版本标签。')
      const region = report.region
      const p = request.player.progress
      if (region.sector > p.highest_sectors[region.layer]) throw new Error('本轮尚未到达所选层域的该区域。')
      if (region.sector < p.umbra_sector_number !== (region.layer === 'umbra'))
        throw new Error('实际层域不符：只有低于合并边界的区域属于本影域，边界本身不属于本影域。')
      if (
        request.settings.mode === 'boss_once' &&
        ['antumbra', 'penumbra'].includes(region.layer) &&
        p.highest_sectors.surface <= region.sector
      )
        throw new Error('该层域首领要求本轮表象域已到达下一区域。')
      const id = 'manager_' + randomUUID().replaceAll('-', '')
      const snapshotRoot = join(this.folder, 'tasks', id)
      await mkdir(snapshotRoot, { recursive: true })
      const playerText = json(request.player)
      const playerPath = join(snapshotRoot, 'player.json')
      await writeFile(playerPath, playerText, { encoding: 'utf8', flag: 'wx' })
      await writeFile(join(snapshotRoot, 'request.json'), json(request), { encoding: 'utf8', flag: 'wx' })
      this.task = {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        request: structuredClone(request),
        inspection: structuredClone(report),
        logs: '',
        resultDirectory: join(this.titanRoot, 'results', id),
      }
      this.publish()
      void this.run(this.task, playerPath, hash(playerText), region)
      return structuredClone(this.task)
    } catch (error) {
      this.busy = false
      throw error
    }
  }
  private async run(task: TitanTask, playerPath: string, playerHash: string, region: TitanInspection['region']) {
    const s = task.request.settings
    const args = [
      'search',
      '--godot',
      s.godotPath,
      '--player',
      playerPath,
      '--sector',
      s.sector,
      '--layer',
      s.layer,
      '--mode',
      s.mode,
      '--budget-seconds',
      String(s.budgetSeconds),
      '--clock',
      s.clock,
      '--seed',
      String(s.seed),
      '--distance-step',
      String(s.distanceStep),
      '--boss-seconds',
      String(s.bossSeconds),
      '--farm-seconds',
      String(s.farmSeconds),
      '--farm-cycles',
      String(s.farmCycles),
      '--label',
      task.id,
    ]
    if (s.sourcePath) args.push('--source', s.sourcePath)
    try {
      const code = await this.execute(
        args,
        chunk => {
          task.logs = (task.logs + chunk).slice(-250000)
          this.publish()
        },
        true,
      )
      task.exitCode = code
      if (task.status === 'canceled') return
      if (code !== 0 && code !== 3) throw new Error(`泰坦搜索失败（退出码 ${code}），请展开运行日志。`)
      const result = (await readOptional(join(task.resultDirectory, 'result.json'))) as TitanResult | undefined
      if (
        !result ||
        result.mode !== s.mode ||
        result.region?.sector_id !== region.sector_id ||
        result.region?.sector !== region.sector ||
        result.region?.layer !== s.layer ||
        result.player_sha256 !== playerHash ||
        typeof result.output_directory !== 'string' ||
        resolve(result.output_directory) !== resolve(task.resultDirectory)
      )
        throw new Error('结果缺失或与当前任务快照不符，已拒绝读取。')
      if (result.status === 'BUDGET_EXHAUSTED' || result.status === 'CANCELLED') {
        task.status = result.status === 'CANCELLED' ? 'canceled' : 'no_result'
        task.logs += '\n本次运行未以最终成功状态结束，候选仅保留在原始诊断文件中，不发布推荐。\n'
        return
      }
      if (code === 0 && !this.verified(result, s)) throw new Error('搜索未提供符合最终验证要求的推荐结果。')
      if (code === 3 && result.best) throw new Error('退出码与结果状态不一致，已拒绝发布推荐。')
      const resultText = await readFile(join(task.resultDirectory, 'result.txt'), 'utf8')
      task.result = result
      task.resultText = resultText
      task.status = code === 0 ? 'success' : 'no_result'
    } catch (error) {
      if (task.status !== 'canceled') {
        task.status = 'failed'
        task.error = String(error)
      }
    } finally {
      task.finishedAt = new Date().toISOString()
      this.process = undefined
      this.busy = false
      this.publish()
    }
  }
  private verified(result: TitanResult, settings: TitanSettings) {
    const best = result.best
    if (!best?.candidate || !titanCandidateSchema.safeParse(best.candidate).success || !Number.isFinite(best.distance))
      return false
    if (result.status !== (settings.mode === 'boss_once' ? 'KILL_FOUND' : 'BEST_VALIDATED_DISTANCE_FOUND')) return false
    if (settings.mode === 'boss_once') return best.battle?.boss_killed === true
    const checks = best.validation
    if (!checks || checks.length !== 3 || new Set(checks.map(item => item.seed)).size !== 3) return false
    return checks.every(({ battle }) => {
      const samples = battle.cycle_shield_fractions
      return (
        battle.status === 'NATIVE_SMOKE_ONLY' &&
        battle.observation_complete === true &&
        battle.deaths === 0 &&
        typeof battle.seconds === 'number' &&
        battle.seconds >= settings.farmSeconds &&
        typeof battle.colossal_kills === 'number' &&
        battle.colossal_kills >= settings.farmCycles &&
        typeof battle.distance_min === 'number' &&
        Math.abs(battle.distance_min - best.distance) < 0.01 &&
        typeof battle.distance_max === 'number' &&
        Math.abs(battle.distance_max - best.distance) < 0.01 &&
        Array.isArray(samples) &&
        samples.length >= settings.farmCycles &&
        samples.every(item => typeof item === 'number' && Number.isFinite(item)) &&
        Math.min(...samples.slice(-3)) >= Math.min(...samples.slice(-6, -3)) - 0.002
      )
    })
  }
  async stop() {
    if (!this.task || this.task.status !== 'running') return
    const task = this.task
    task.status = 'canceled'
    try {
      if (this.terminate) await this.terminate()
      else if (this.process?.pid) {
        const pid = this.process.pid
        await new Promise<void>((done, reject) => {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
          killer.once('error', reject)
          killer.once('close', code => (code === 0 ? done() : reject(new Error(`停止泰坦进程失败（${code}）。`))))
        })
      }
    } catch (error) {
      task.status = 'running'
      throw error
    }
    this.publish()
  }
  private execute(args: string[], output: (text: string) => void, track: boolean): Promise<number> {
    if (this.executor) return this.executor(args, output)
    return new Promise((done, reject) => {
      // Every value is quoted; percent/newline/quote expansion is rejected by schemas.
      if (args.some(value => /[\r\n\x00"%]/.test(value))) {
        reject(new Error('运行路径包含不支持的字符。'))
        return
      }
      const command = ['run_titan.bat', ...args].map(value => `"${value}"`).join(' ')
      const child = spawn('cmd.exe', ['/d', '/v:off', '/s', '/c', `"${command}"`], {
        cwd: this.titanRoot,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      })
      if (track) this.process = child
      const stdout = new StringDecoder('utf8'),
        stderr = new StringDecoder('utf8')
      child.stdout?.on('data', chunk => output(stdout.write(chunk)))
      child.stderr?.on('data', chunk => output(stderr.write(chunk)))
      child.once('error', reject)
      child.once('close', code => {
        output(stdout.end())
        output(stderr.end())
        done(code ?? 2)
      })
    })
  }
}

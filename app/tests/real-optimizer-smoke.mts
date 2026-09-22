import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DataRepository } from '../src/main/services/data-repository'
import { OptimizerRunner } from '../src/main/services/optimizer-runner'
import { diffFormation } from '../src/shared/formation-diff'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(appRoot, '..')
const optimizerRoot = join(repositoryRoot, 'fleetSimulation')
const galaxy = 'g6',
  node = 'B3'
const mapGalaxy = join(optimizerRoot, 'map', galaxy)
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const smokeBudget = { max_wall_seconds: 1, max_simulations: 1, workers: 1 }
const overwrittenProjectFiles = [
  'config.json',
  'common.json',
  'optimizer_v2_daily.json',
  'fleet_test.gd',
  'fleet_test_runner.gd',
  'friendly_config_resolver.gd',
  'fleet_optimizer.gd',
  'fleet_optimizer_v2.gd',
  'fleet_optimizer_search.gd',
  'fleet_optimizer_regression.gd',
  'optimizer_benchmark_cases.json',
  'fleet_battle_analyzer.gd',
  'fleet_optimizer_bootstrap.gd',
  'fleet_optimizer_bootstrap.tscn',
  'fleet_optimizer_battle_area.gd',
].map(file => join(optimizerRoot, 'work', 'full_recovered', file))
const restoreTargets = [
  join(mapGalaxy, `${node}.json`),
  join(mapGalaxy, 'common.json'),
  join(mapGalaxy, `${node}.result.json`),
  join(mapGalaxy, `${node}.result.txt`),
  join(mapGalaxy, `${node}.godot.log`),
  join(optimizerRoot, 'results', 'latest.json'),
  join(optimizerRoot, 'results', 'latest.txt'),
  join(optimizerRoot, 'results', 'latest_summary.json'),
  join(appRoot, 'runtime', 'last-task.json'),
  ...overwrittenProjectFiles,
]

type Backup = { path: string; bytes?: Buffer; hash?: string }
const snapshot = async (path: string): Promise<Backup> => {
  try {
    const bytes = await readFile(path)
    return { path, bytes, hash: hash(bytes) }
  } catch {
    return { path }
  }
}
const restore = async (backup: Backup) => {
  if (backup.bytes) {
    await mkdir(dirname(backup.path), { recursive: true })
    await writeFile(backup.path, backup.bytes)
  } else await rm(backup.path, { force: true })
}

const backups = await Promise.all(restoreTargets.map(snapshot))
const nodeBefore = backups.find(item => item.path.endsWith(`${node}.json`))!
const commonBefore = backups.find(
  item => item.path.endsWith('common.json') && item.path.includes(`${optimizerRoot}\\map`),
)!
let temporaryDataRoot: string | undefined
let report: Record<string, unknown> = { galaxy, node, smokeBudget, startedAt: new Date().toISOString() }

try {
  const originalNode = JSON.parse(nodeBefore.bytes!.toString('utf8'))
  const originalCommon = JSON.parse(commonBefore.bytes!.toString('utf8'))
  const smokeNode = { ...originalNode, search: { ...originalNode.search, ...smokeBudget } }
  temporaryDataRoot = await mkdtemp(join(tmpdir(), 'optimizer-real-smoke-'))
  const managerGalaxy = join(temporaryDataRoot, 'galaxies', galaxy)
  await mkdir(join(managerGalaxy, 'nodes', node, 'versions'), { recursive: true })
  await mkdir(join(managerGalaxy, 'common', 'versions'), { recursive: true })
  await writeFile(
    join(managerGalaxy, 'nodes', node, 'versions', 'smoke.json'),
    `${JSON.stringify(smokeNode, null, 2)}\n`,
  )
  await writeFile(
    join(managerGalaxy, 'nodes', node, 'versions', 'control.json'),
    `${JSON.stringify(smokeNode, null, 2)}\n`,
  )
  await writeFile(
    join(managerGalaxy, 'common', 'versions', 'smoke.json'),
    `${JSON.stringify(originalCommon, null, 2)}\n`,
  )

  const output: string[] = []
  const runner = new OptimizerRunner(
    new DataRepository(temporaryDataRoot, join(optimizerRoot, 'map')),
    optimizerRoot,
    line => output.push(line),
  )
  const resultBefore = await snapshot(join(mapGalaxy, `${node}.result.json`))
  const startedMs = Date.now()
  const run = await runner.run({ galaxy, node, version: 'smoke', common: 'smoke' })
  const resultAfter = await snapshot(join(mapGalaxy, `${node}.result.json`))
  if (run.exitCode !== 0 || run.error || !run.result)
    throw new Error(run.error ?? `Optimizer returned exit code ${run.exitCode}`)
  if (!run.result.best_result) throw new Error('New Result has no best_result.')
  if (!resultAfter.bytes || resultBefore.hash === resultAfter.hash)
    throw new Error('Result content was not newly generated.')
  const resultStat = await stat(join(mapGalaxy, `${node}.result.json`))
  if (resultStat.mtimeMs < startedMs) throw new Error('Result mtime predates this smoke run.')
  const base = run.result.base_config as
    { resolver?: { friendly_input?: { galaxy?: number; node?: string } } } | undefined
  const identity = base?.resolver?.friendly_input
  if (identity?.galaxy !== 6 || identity.node?.toLowerCase() !== node.toLowerCase())
    throw new Error('Result Galaxy/Node identity is invalid.')
  const changes = diffFormation(run.result.verified_baseline, run.result.best_result)
  const combinedOutput = output.join('')
  if (!combinedOutput.includes('Initializing Fleet Optimizer'))
    throw new Error('BAT invocation was not observed in Runner output.')
  if (!combinedOutput.includes('Godot log:'))
    throw new Error('Godot process completion was not observed in Runner output.')
  const controlBeforeCopy = await readFile(join(managerGalaxy, 'nodes', node, 'versions', 'control.json'))
  const copy = await runner.useBest(run.task!.taskId)
  if (copy.exitCode !== 0 || copy.error || !copy.node)
    throw new Error(copy.error ?? `Optimizer copy returned exit code ${copy.exitCode}`)
  const managerAfterCopy = JSON.parse(
    await readFile(join(managerGalaxy, 'nodes', node, 'versions', 'smoke.json'), 'utf8'),
  )
  const workspaceAfterCopy = JSON.parse(await readFile(join(mapGalaxy, `${node}.json`), 'utf8'))
  const controlAfterCopy = await readFile(join(managerGalaxy, 'nodes', node, 'versions', 'control.json'))
  if (JSON.stringify(managerAfterCopy) !== JSON.stringify(workspaceAfterCopy))
    throw new Error('Manager selected Version does not match --c workspace output.')
  if (hash(controlBeforeCopy) !== hash(controlAfterCopy))
    throw new Error('Unselected Manager Version was modified by --c copy.')
  report = {
    ...report,
    runnerExitCode: run.exitCode,
    runnerOutputChunks: output.length,
    runnerOutputContainsBatchStart: true,
    runnerOutputContainsGodotCompletion: true,
    resultChanged: resultBefore.hash !== resultAfter.hash,
    resultMtimeMs: resultStat.mtimeMs,
    resultSchemaParsed: true,
    resultIdentity: identity,
    bestFound: {
      outcome: run.result.best_result.outcome,
      fleetResourcesUsed: run.result.best_result.fleet_resources_used,
      formationKey: run.result.best_result.formation_key,
      formationEntries: run.result.best_result.formation.length,
    },
    formationLoadoutDiff: changes,
    copyBestFound: {
      exitCode: copy.exitCode,
      selectedVersionMatchesWorkspace: true,
      unselectedVersionUnchanged: true,
      managerSchemaParsed: true,
    },
  }
} finally {
  await Promise.all(backups.map(restore))
  const restoredNode = await snapshot(nodeBefore.path)
  const restoredCommon = await snapshot(commonBefore.path)
  report = {
    ...report,
    finishedAt: new Date().toISOString(),
    restoration: {
      node: { before: nodeBefore.hash, after: restoredNode.hash, matches: nodeBefore.hash === restoredNode.hash },
      common: {
        before: commonBefore.hash,
        after: restoredCommon.hash,
        matches: commonBefore.hash === restoredCommon.hash,
      },
    },
  }
  if (temporaryDataRoot) await rm(temporaryDataRoot, { recursive: true, force: true })
  const reportPath = join(appRoot, 'runtime', `optimizer-real-smoke-${Date.now()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
}

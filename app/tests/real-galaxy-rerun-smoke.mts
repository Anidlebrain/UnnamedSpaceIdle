import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DataRepository } from '../src/main/services/data-repository'
import { GalaxyRerunService } from '../src/main/services/galaxy-rerun'
import { OptimizerRunner } from '../src/main/services/optimizer-runner'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(appRoot, '..')
const optimizerRoot = join(repositoryRoot, 'fleetSimulation')
const managerRoot = join(appRoot, 'data')
const galaxy = 'g6'
const smokeBudget = { max_wall_seconds: 1, max_simulations: 1, workers: 1 }
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
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

const sourceRepo = new DataRepository(managerRoot, join(optimizerRoot, 'map'))
const sourceGalaxy = (await sourceRepo.catalog()).galaxies.find(item => item.id === galaxy)
if (!sourceGalaxy) throw new Error(`Manager data has no ${galaxy}.`)
const selectedNodes = sourceGalaxy.nodes.slice(0, 2)
if (selectedNodes.length < 2) throw new Error(`${galaxy} needs at least two Nodes for the serial smoke.`)
const selections = selectedNodes.map(item => ({
  galaxy,
  node: item.id,
  version: item.defaultVersion,
  common: sourceGalaxy.defaultCommon,
}))
const managerPaths = [
  join(managerRoot, 'galaxies', galaxy, 'common', 'versions', `${sourceGalaxy.defaultCommon}.json`),
  ...selections.map(item =>
    join(managerRoot, 'galaxies', galaxy, 'nodes', item.node, 'versions', `${item.version}.json`),
  ),
]
const managerBefore = await Promise.all(managerPaths.map(snapshot))
const mapGalaxy = join(optimizerRoot, 'map', galaxy)
const projectFiles = [
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
const workspaceTargets = [
  join(optimizerRoot, 'map', 'search_config.json'),
  join(optimizerRoot, 'map', 'optimizer_v2_daily.json'),
  join(mapGalaxy, 'common.json'),
  ...selections.flatMap(item => {
    const resultNode = item.node.replace(/_num$/i, '')
    return [
      join(mapGalaxy, `${item.node}.json`),
      join(mapGalaxy, `${resultNode}.result.json`),
      join(mapGalaxy, `${resultNode}.result.txt`),
      join(mapGalaxy, `${resultNode}.godot.log`),
    ]
  }),
  join(optimizerRoot, 'results', 'latest.json'),
  join(optimizerRoot, 'results', 'latest.txt'),
  join(optimizerRoot, 'results', 'latest_summary.json'),
  join(appRoot, 'runtime', 'last-task.json'),
  ...projectFiles,
]
const workspaceBefore = await Promise.all(workspaceTargets.map(snapshot))
let temporaryDataRoot: string | undefined
let report: Record<string, unknown> = {
  galaxy,
  nodes: selections.map(item => item.node),
  smokeBudget,
  startedAt: new Date().toISOString(),
}

try {
  temporaryDataRoot = await mkdtemp(join(tmpdir(), 'galaxy-rerun-real-smoke-'))
  const targetGalaxy = join(temporaryDataRoot, 'galaxies', galaxy)
  await mkdir(join(targetGalaxy, 'common', 'versions'), { recursive: true })
  const sourceCommon = (await sourceRepo.load(selections[0])).common
  await writeFile(join(targetGalaxy, 'common', 'versions', 'smoke.json'), JSON.stringify(sourceCommon))
  await writeFile(
    join(targetGalaxy, 'common', 'meta.json'),
    JSON.stringify({ default_profile: 'smoke', profiles: [{ id: 'smoke', name: 'Smoke' }] }),
  )
  for (const selection of selections) {
    const sourceNode = (await sourceRepo.load(selection)).node
    const smokeNode = { ...sourceNode, search: { ...sourceNode.search, ...smokeBudget } }
    const directory = join(targetGalaxy, 'nodes', selection.node)
    await mkdir(join(directory, 'versions'), { recursive: true })
    await writeFile(join(directory, 'versions', 'smoke.json'), JSON.stringify(smokeNode))
    await writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({ default_version: 'smoke', versions: [{ id: 'smoke', name: 'Smoke' }] }),
    )
  }
  const temporaryManagerPaths = selections.map(item => join(targetGalaxy, 'nodes', item.node, 'versions', 'smoke.json'))
  const temporaryManagerBefore = await Promise.all(temporaryManagerPaths.map(path => readFile(path)))
  const output: string[] = []
  const progress: string[] = []
  const temporaryRepo = new DataRepository(temporaryDataRoot, join(optimizerRoot, 'map'))
  await temporaryRepo.saveSearchConfig({
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step',
    ...smokeBudget,
  })
  const runner = new OptimizerRunner(temporaryRepo, optimizerRoot, line => output.push(line))
  const result = await new GalaxyRerunService(temporaryRepo, runner, state => {
    progress.push(`${state.completed}/${state.total}:${state.currentNode ?? 'done'}`)
  }).run({
    galaxy,
    nodes: selections.map(item => item.node),
    search: {
      profile: 'fast',
      goal: 'beat_baseline',
      simulation_clock: 'offline_fixed_step',
      ...smokeBudget,
    },
  })
  if (result.nodes.some(item => item.status === 'failed'))
    throw new Error(`Smoke Node failed: ${result.nodes.find(item => item.status === 'failed')?.error}`)
  if (!output.join('').includes('Initializing Fleet Optimizer'))
    throw new Error('Real BAT invocation was not observed.')
  const queueRunner = new OptimizerRunner(temporaryRepo, optimizerRoot, () => {})
  const queueRequest = (selection: (typeof selections)[number], maxWall = 1) => ({
    ...selection,
    version: 'smoke',
    common: 'smoke',
    versionName: 'Smoke',
    commonName: 'Smoke',
    search: {
      profile: 'fast' as const,
      goal: 'beat_baseline' as const,
      simulation_clock: 'offline_fixed_step' as const,
      max_wall_seconds: maxWall,
      max_simulations: maxWall === 1 ? 1 : 100000,
      workers: 1,
    },
  })
  const until = async (check: () => boolean, label: string, timeoutMs = 90000) => {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  await queueRunner.enqueue(queueRequest(selections[0]))
  await queueRunner.enqueue(queueRequest(selections[1]))
  await until(
    () =>
      queueRunner
        .getQueue()
        .slice(0, 2)
        .every(item => ['success', 'failed'].includes(item.status)),
    'serial queue',
  )
  const queueResult = queueRunner.getQueue().slice(0, 2)
  if (queueResult.some(item => item.status !== 'success'))
    throw new Error(
      `Real queue failed: ${queueResult.map(item => `${item.snapshot.node}:${item.run?.error}`).join('; ')}`,
    )

  await queueRunner.enqueue(queueRequest(selections[0], 120))
  await until(() => queueRunner.getQueue()[2]?.logs.includes('Initializing Fleet Optimizer'), 'current BAT start')
  const stopCurrentAt = Date.now()
  await queueRunner.stopCurrentTask()
  await until(() => queueRunner.getQueue()[2]?.status === 'canceled', 'current stop', 15000)
  const stopCurrentMs = Date.now() - stopCurrentAt

  await queueRunner.enqueue(queueRequest(selections[0], 120))
  await queueRunner.enqueue(queueRequest(selections[1], 120))
  await until(() => queueRunner.getQueue()[3]?.logs.includes('Initializing Fleet Optimizer'), 'batch BAT start')
  const stopAllAt = Date.now()
  await queueRunner.stopAllTasks()
  await until(
    () =>
      queueRunner
        .getQueue()
        .slice(3, 5)
        .every(item => item.status === 'canceled'),
    'queue stop',
    15000,
  )
  const stopAllMs = Date.now() - stopAllAt
  await queueRunner.enqueue(queueRequest(selections[0]))
  await until(() => queueRunner.getQueue()[5]?.status === 'success', 'post-stop restart')

  const rerunSearch = {
    profile: 'fast' as const,
    goal: 'beat_baseline' as const,
    simulation_clock: 'offline_fixed_step' as const,
    ...smokeBudget,
  }
  const rerunOutput: string[] = []
  const stopRerunRunner = new OptimizerRunner(temporaryRepo, optimizerRoot, line => rerunOutput.push(line))
  const stopRerunService = new GalaxyRerunService(temporaryRepo, stopRerunRunner, () => {})
  const partialRun = stopRerunService.run({ galaxy, nodes: selections.map(item => item.node), search: rerunSearch })
  await until(() => rerunOutput.join('').includes('Initializing Fleet Optimizer'), 'rerun current BAT')
  await stopRerunRunner.stopCurrentTask()
  const partialProgress = await partialRun
  if (partialProgress.nodes[0].status !== 'canceled' || partialProgress.nodes[1].status !== 'succeeded')
    throw new Error(`Rerun stop-current behavior invalid: ${partialProgress.nodes.map(item => item.status)}`)

  const stopBatchOutput: string[] = []
  const stopBatchRunner = new OptimizerRunner(temporaryRepo, optimizerRoot, line => stopBatchOutput.push(line))
  const stopBatchService = new GalaxyRerunService(temporaryRepo, stopBatchRunner, () => {})
  const batchRun = stopBatchService.run({
    galaxy,
    nodes: selections.map(item => item.node),
    search: {
      ...rerunSearch,
      max_wall_seconds: 120,
      max_simulations: 100000,
    },
  })
  await until(() => stopBatchOutput.join('').includes('Initializing Fleet Optimizer'), 'rerun batch BAT')
  await stopBatchRunner.stopAllTasks()
  const batchProgress = await batchRun
  if (batchProgress.nodes.some(item => item.status !== 'canceled'))
    throw new Error(`Rerun stop-all behavior invalid: ${batchProgress.nodes.map(item => item.status)}`)
  const temporaryManagerAfter = await Promise.all(temporaryManagerPaths.map(path => readFile(path)))
  report = {
    ...report,
    status: result.status,
    completed: result.completed,
    serialProgress: progress,
    nodes: result.nodes.map(item => ({
      node: item.node,
      status: item.status,
      changed: item.changed,
      exitCode: item.run?.exitCode,
      elapsedMs:
        item.startedAt && item.finishedAt ? Date.parse(item.finishedAt) - Date.parse(item.startedAt) : undefined,
    })),
    batchUsedSearchOnly: true,
    searchSnapshots: result.nodes.map(item => item.run?.task?.search),
    realQueue: queueResult.map(item => ({
      node: item.snapshot.node,
      status: item.status,
      taskId: item.snapshot.taskId,
      exitCode: item.run?.exitCode,
    })),
    stopCurrent: { status: queueRunner.getQueue()[2].status, elapsedMs: stopCurrentMs },
    stopAll: {
      statuses: queueRunner
        .getQueue()
        .slice(3, 5)
        .map(item => item.status),
      elapsedMs: stopAllMs,
    },
    postStopRestart: queueRunner.getQueue()[5].status,
    rerunStopCurrent: partialProgress.nodes.map(item => item.status),
    rerunStopAll: batchProgress.nodes.map(item => item.status),
    temporaryManagerConfigsUnchanged: temporaryManagerAfter.every(
      (bytes, index) => hash(bytes) === hash(temporaryManagerBefore[index]),
    ),
  }
} finally {
  await Promise.all(workspaceBefore.map(restore))
  const managerAfter = await Promise.all(managerPaths.map(snapshot))
  report = {
    ...report,
    finishedAt: new Date().toISOString(),
    managerDataRestored: managerBefore.every((before, index) => before.hash === managerAfter[index].hash),
    workspaceRestored: (await Promise.all(workspaceTargets.map(snapshot))).every(
      (after, index) => after.hash === workspaceBefore[index].hash,
    ),
  }
  if (temporaryDataRoot) await rm(temporaryDataRoot, { recursive: true, force: true })
  const reportPath = join(appRoot, 'runtime', `galaxy-rerun-real-smoke-${Date.now()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
}

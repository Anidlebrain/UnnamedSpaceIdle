import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TitanService } from '../src/main/services/titan-service'
import { titanPlayerSchema, type TitanTask } from '../src/shared/titan'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const titanRoot = join(appRoot, '..', 'titanSimulation')
const root = join(appRoot, 'runtime', 'titan-smoke', randomUUID())
await mkdir(root, { recursive: true })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fingerprint(path: string) {
  try {
    return sha(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
const protectedFiles = [
  join(titanRoot, 'local', 'player.json'),
  join(titanRoot, 'local', 'current_source.json'),
  join(appRoot, 'data', 'titan', 'player.json'),
  join(appRoot, 'data', 'titan', 'settings.json'),
  join(titanRoot, 'examples', 'player.synthetic.0.90.json'),
]
const before = await Promise.all(protectedFiles.map(fingerprint))
let latest: TitanTask | null = null
const service = new TitanService(join(root, 'data'), titanRoot, task => {
  latest = task
})
try {
  const workspace = await service.load()
  assert(workspace.settings.godotPath, 'Existing verified Godot executable must be discoverable')
  const player = titanPlayerSchema.parse(
    JSON.parse(await readFile(join(titanRoot, 'examples', 'player.synthetic.0.90.json'), 'utf8')),
  )
  const settings = {
    ...workspace.settings,
    sector: '164',
    layer: 'antumbra' as const,
    mode: 'boss_once' as const,
    budgetSeconds: 240,
    clock: 'fixed' as const,
  }
  const started = await service.start({ player, settings })
  assert.equal(started.status, 'running')
  console.info('[real-titan-smoke] started', started.id, started.resultDirectory)
  const deadline = Date.now() + (settings.budgetSeconds + 60) * 1000
  while (service.current()?.status === 'running' && Date.now() < deadline)
    await new Promise(done => setTimeout(done, 500))
  if (service.current()?.status === 'running') {
    await service.stop()
    throw new Error('Titan service exceeded the end-to-end smoke timeout')
  }
  const final = service.current()!
  await writeFile(join(root, 'task.json'), JSON.stringify(final, null, 2), 'utf8')
  await writeFile(join(root, 'stdout.log'), final.logs, 'utf8')
  assert.equal(final.status, 'success', final.error ?? final.result?.status ?? final.logs.slice(-4000))
  assert.equal(final.exitCode, 0)
  assert.equal(final.result?.region.sector, 164)
  assert.equal(final.result?.region.layer, 'antumbra')
  assert.equal(final.result?.mode, 'boss_once')
  assert.equal(final.result?.status, 'KILL_FOUND')
  assert.equal(final.result?.best?.battle?.boss_killed, true)
  assert.equal(final.result?.output_directory, final.resultDirectory)
  const snapshotPath = join(root, 'data', 'titan', 'tasks', started.id, 'player.json')
  assert.equal(final.result?.player_sha256, sha(await readFile(snapshotPath)))
  assert(final.resultText?.includes('实际首领击杀时间'))
  assert(final.logs.includes('KILL_FOUND'))
  assert(latest && (latest as TitanTask).status === 'success', 'Final task event must reach renderer subscribers')
  console.info(
    '[real-titan-smoke] verified',
    JSON.stringify({
      taskId: final.id,
      status: final.status,
      trials: final.result?.trials,
      wallSeconds: final.result?.wall_seconds,
      killSeconds: final.result?.best?.battle?.seconds,
      resultDirectory: final.resultDirectory,
      diagnostics: root,
      playerSnapshotSha256: final.result?.player_sha256,
    }),
  )
} finally {
  if (service.current()?.status === 'running') await service.stop()
  const after = await Promise.all(protectedFiles.map(fingerprint))
  assert.deepEqual(after, before, 'Existing local and Manager profiles/settings/examples must remain byte-identical')
}

import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const roots: string[] = []
const script = fileURLToPath(new URL('../../fleetSimulation/tools/copy_result_to_config.ps1', import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'win32')('copy_result_to_config.ps1', () => {
  it('keeps unused ship loadouts while replacing the result ships', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-copy-result-'))
    roots.push(root)
    const summary = join(root, 'B38.result.txt')
    const config = join(root, 'B38.json')
    await writeFile(
      summary,
      'Mods:\n  1: Primary=0; Secondary=0\n  5: Primary=1; Secondary=0\n\nFormation:\nA 0 0 0 1 0\nB 0 5 0 5 0\n',
    )
    await writeFile(
      config,
      JSON.stringify({
        baseline: {
          enabled: true,
          formation: { A1: 4 },
          loadouts: {
            Fighter: { primary: 1, secondary: 0 },
            Cruiser: { primary: 0, secondary: 1 },
          },
        },
      }),
    )

    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, summary, config])
    const copied = JSON.parse(await readFile(config, 'utf8'))
    expect(copied.baseline.loadouts).toEqual({
      Cruiser: { primary: 0, secondary: 1 },
      Fighter: { primary: 0, secondary: 0 },
      HeavyCruiser: { primary: 1, secondary: 0 },
    })
    expect(copied.baseline.formation).toMatchObject({ A4: 1, B2: 5, B4: 5 })
  })
})

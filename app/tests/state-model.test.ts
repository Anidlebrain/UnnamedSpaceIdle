import { describe, expect, it } from 'vitest'
import {
  commonLocked,
  initialContexts,
  nodeLocked,
  taskFromSnapshot,
  updateSelection,
} from '../src/renderer/state-model'
import type { Catalog, SearchTaskSnapshot } from '../src/shared/contracts'

const catalog: Catalog = {
  galaxies: [
    {
      id: 'g6',
      nodes: [
        { id: 'B21', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
        { id: 'B25', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
      ],
      defaultCommon: 'default',
      commons: [{ id: 'default', name: '默认', isDefault: true }],
    },
    {
      id: 'g7',
      nodes: [{ id: 'B7', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] }],
      defaultCommon: 'default',
      commons: [{ id: 'default', name: '默认', isDefault: true }],
    },
  ],
  templates: [],
}

const snapshot: SearchTaskSnapshot = {
  taskId: 'task-b21',
  galaxy: 'g6',
  node: 'B21',
  version: 'default',
  versionName: '默认',
  common: 'default',
  commonName: '默认',
  nodeConfigHash: 'node',
  commonConfigHash: 'common',
  optimizerConfigHash: 'optimizer',
  optimizerConfigVersion: 'sha256:optimizer',
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step',
    max_wall_seconds: 600,
    max_simulations: 100,
    workers: 1,
  },
  startedAt: '2026-09-21T00:00:00.000Z',
}

describe('renderer state model', () => {
  it('keeps page selections independent', () => {
    const contexts = initialContexts(catalog, { galaxy: 'g6', node: 'B21', version: 'default', common: 'default' })
    contexts.node = updateSelection(catalog, contexts.node, 'node', 'B25')
    contexts.templates = updateSelection(catalog, contexts.templates, 'galaxy', 'g7')
    expect(contexts.node.node).toBe('B25')
    expect(contexts.search.node).toBe('B21')
    expect(contexts.templates).toMatchObject({ galaxy: 'g7', node: 'B7' })
  })

  it('locks only the task Version and task Common while allowing unrelated data', () => {
    const task = taskFromSnapshot(snapshot)
    expect(nodeLocked(task, snapshot)).toBe(true)
    expect(nodeLocked(task, { ...snapshot, node: 'B25' })).toBe(false)
    expect(commonLocked(task, snapshot)).toBe(true)
    expect(commonLocked(task, { ...snapshot, galaxy: 'g7' })).toBe(false)
    expect(nodeLocked({ ...task, status: 'completed' }, snapshot)).toBe(false)
  })
})

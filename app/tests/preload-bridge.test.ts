import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLEET_MANAGER_BRIDGE_NAME } from '../src/shared/bridge'

const exposeInMainWorld = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke: vi.fn(), on, removeListener } }))

describe('preload bridge contract', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
  it('exposes the shared fleetManager name and returns an output unsubscribe function', async () => {
    await import('../src/preload/index')
    expect(exposeInMainWorld).toHaveBeenCalledWith(FLEET_MANAGER_BRIDGE_NAME, expect.objectContaining({ catalog: expect.any(Function), onOutput: expect.any(Function) }))
    const api = exposeInMainWorld.mock.calls[0][1] as { onOutput: (listener: (line: string) => void) => () => void }
    const unsubscribe = api.onOutput(vi.fn())
    expect(on).toHaveBeenCalledWith('optimizer:output', expect.any(Function))
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('optimizer:output', expect.any(Function))
  })
})

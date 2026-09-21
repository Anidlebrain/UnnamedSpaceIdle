import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FLEET_MANAGER_BRIDGE_NAME } from '../../src/shared/bridge'
import { App } from '../../src/renderer/App'

const node = { galaxy: 6, node: 'B1', hazards: [], supports: [], player_state: { fleet_resources: 1, ships: { Fighter: 1 } }, baseline: { enabled: true, formation: { A1: 'Fighter' }, loadouts: { Fighter: { primary: null, secondary: null, tertiary_mods: [] } } }, search: { profile: 'fast', goal: 'beat_baseline', simulation_clock: 'offline_fixed_step' as const, max_wall_seconds: 1, max_simulations: 1, workers: 1 } }
const unsubscribe = vi.fn()
const api = { catalog: vi.fn(async () => ({ galaxies: [{ id: 'g6', nodes: [{ id: 'B1', versions: ['default'] }], commons: ['default'] }] })), load: vi.fn(async () => ({ node, common: { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } } })), save: vi.fn(async (_selection: unknown, _node: unknown) => {}), run: vi.fn(), previewImport: vi.fn(), importMap: vi.fn(), onOutput: vi.fn(() => unsubscribe) }

describe('Renderer preload contract', () => {
  afterEach(cleanup)
  beforeEach(() => { window[FLEET_MANAGER_BRIDGE_NAME] = api; vi.clearAllMocks() })
  it('mounts with the preload API, calls catalog, and renders the main UI', async () => { render(<App />); await screen.findByText('配置编辑'); expect(api.catalog).toHaveBeenCalled(); await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(14)) })
  it('renders a clear startup error when the preload API is missing', () => { delete window[FLEET_MANAGER_BRIDGE_NAME]; render(<App />); expect(screen.getByText('Fleet Manager 启动失败')).toBeTruthy(); expect(screen.getByText('Preload API 未加载。请检查 Electron preload 配置。')).toBeTruthy() })
  it('registers and cleans up the output subscription', () => { const view = render(<App />); expect(api.onOutput).toHaveBeenCalledTimes(1); view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1) })
  it('blocks dirty search and has no direct node APIs', async () => { render(<App />); await screen.findByText('原始 JSON'); fireEvent.change(screen.getByLabelText('Node JSON 编辑器'), { target: { value: '{}' } }); fireEvent.click(screen.getByText('启动 Optimizer')); expect(screen.getByText(/未保存修改/)).toBeTruthy(); const source = await import('node:fs/promises').then(x => x.readFile('src/renderer/App.tsx', 'utf8')); expect(source).not.toMatch(/from ['"]node:(fs|child_process)/) })
})

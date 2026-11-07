import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TitanResult, TitanWorkspace } from '../../src/renderer/TitanWorkspace'
import { DEFAULT_TITAN_SETTINGS } from '../../src/shared/titan'
import type { TitanApi, TitanPlayer, TitanTask, TitanWorkspace as WorkspaceData } from '../../src/shared/titan'

const player: TitanPlayer = {
  statistics: {
    game_version: '0.90.0.1',
    reference_layer: 'surface',
    temporary_combat_effects_active: false,
    summary_stats: { titan_damage: 2.2e20, titan_max_shields: 3e21, array_capacity: 1 },
    alignment: { antumbra: 0, penumbra: 0 },
    reference_array_level: 0,
    reference_array_base_damage: 4e20,
    core_level_caps: { TitanLaser: 0, TitanShield: 0, TitanArray: 0 },
  },
  progress: {
    highest_sectors: { surface: 160, antumbra: 0, penumbra: 0, umbra: 0 },
    umbra_sector_number: 0,
    reintegration: false,
    galaxy12_unlocked: false,
  },
}
const settings = { ...DEFAULT_TITAN_SETTINGS, godotPath: 'E:\\tools\\godot.exe' }
const candidate = {
  weapons: Array.from({ length: 3 }, () => ({
    id: 'TitanLaser',
    level: 0,
    milestones: {},
    targeting: { type: 'Unarmored', priority: 'Highest HP', swapping: 'Keep Target', overlap: 'Allow' },
  })),
  shield: { level: 0 },
  array_core: { level: 0 },
  array_capacity: 1,
  sequence: [{ id: 'laser_shot', targets: ['1:1'] }],
}
const region = {
  sector: 160,
  sector_id: 'sector160',
  layer: 'surface' as const,
  distance_start: 100,
  distance_end: 200,
  array_targets: [{ id: '1:1', system: 'DEFENSIVE_PLATING', number: 1 }],
}
function task(overrides: Partial<TitanTask> = {}): TitanTask {
  return {
    id: 'titan-original',
    status: 'running',
    startedAt: new Date().toISOString(),
    request: structuredClone({ player, settings }),
    logs: '',
    resultDirectory: 'results/titan-original',
    ...overrides,
  }
}
function mockApi(initialPlayer: TitanPlayer | null = player) {
  let listener: ((value: TitanTask) => void) | undefined
  const workspace: WorkspaceData = { player: initialPlayer, settings, playerSource: initialPlayer ? 'manager' : 'none' }
  const api: TitanApi = {
    load: vi.fn(async () => structuredClone(workspace)),
    savePlayer: vi.fn(async value => structuredClone(value)),
    saveSettings: vi.fn(async value => structuredClone(value)),
    inspect: vi.fn(),
    current: vi.fn(async () => null),
    stop: vi.fn(async () => {}),
    start: vi.fn(async request => task({ request: structuredClone(request) })),
    onTask: vi.fn(callback => {
      listener = callback
      return () => {
        listener = undefined
      }
    }),
  }
  return {
    api,
    emit: (next: TitanTask) =>
      act(() => {
        listener?.(next)
      }),
  }
}
async function load(api: TitanApi, runtime: 'desktop' | 'web' = 'desktop') {
  render(<TitanWorkspace api={api} runtime={runtime} />)
  await screen.findByRole('tab', { name: '搜索与结果' })
}
function confirmCapture() {
  fireEvent.click(
    screen.getByRole('checkbox', { name: '确认统计在临时战斗技能结束后采集，所填等级支持三槽同时装备。' }),
  )
}
afterEach(cleanup)

describe('Titan workspace UI', () => {
  it('opens an empty profile instead of supplying synthetic statistics', async () => {
    const { api } = mockApi(null)
    await load(api)
    expect((screen.getByLabelText('统计总览 · 泰坦伤害') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('tab', { name: '玩家档案' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '前往搜索' }))
    expect((screen.getByRole('button', { name: '开始泰坦搜索' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.start).not.toHaveBeenCalled()
  })

  it('saves scientific notation and legitimate zero core levels without inventing locked weapons', async () => {
    const { api } = mockApi()
    await load(api)
    fireEvent.click(screen.getByRole('tab', { name: '玩家档案' }))
    fireEvent.change(screen.getByLabelText('统计总览 · 泰坦伤害'), { target: { value: '4.25e22' } })
    confirmCapture()
    fireEvent.click(screen.getByRole('button', { name: '保存玩家档案' }))
    await waitFor(() => expect(api.savePlayer).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(api.savePlayer).mock.calls[0][0]
    expect(saved.statistics.summary_stats.titan_damage).toBe(4.25e22)
    expect(saved.statistics.core_level_caps).toEqual({ TitanLaser: 0, TitanShield: 0, TitanArray: 0 })
    expect(saved.statistics.reference_array_level).toBe(0)
    await screen.findByText('玩家档案已保存。切换搜索目标不会改变档案。')
  })

  it('loads pasted JSON as a draft and requires a separate confirmation and save', async () => {
    const { api } = mockApi(null)
    await load(api)
    fireEvent.click(screen.getByText('高级 · 导入玩家 JSON'))
    fireEvent.change(screen.getByLabelText('泰坦玩家 JSON'), { target: { value: JSON.stringify(player) } })
    fireEvent.click(screen.getByRole('button', { name: '载入编辑器' }))
    await screen.findByText('JSON 已载入草稿，请核对采集条件后保存。')
    expect(api.savePlayer).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '保存玩家档案' }) as HTMLButtonElement).disabled).toBe(true)
    confirmCapture()
    fireEvent.click(screen.getByRole('button', { name: '保存玩家档案' }))
    await waitFor(() => expect(api.savePlayer).toHaveBeenCalledWith(player))
  })

  it('blocks searching with an unsaved player draft and in the browser runtime', async () => {
    const { api } = mockApi()
    await load(api)
    fireEvent.click(screen.getByRole('tab', { name: '玩家档案' }))
    fireEvent.change(screen.getByLabelText('统计总览 · 泰坦伤害'), { target: { value: '7e20' } })
    fireEvent.click(screen.getByRole('button', { name: '前往搜索' }))
    expect((screen.getByRole('button', { name: '开始泰坦搜索' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('玩家档案有未保存草稿，请先核对并保存后再开始搜索。')).toBeDefined()
    cleanup()
    await load(api, 'web')
    expect((screen.getByRole('button', { name: '开始泰坦搜索' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '读取区域资料' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.start).not.toHaveBeenCalled()
  })

  it('keeps completed recommendations bound to the original target after editing the next target', async () => {
    const { api, emit } = mockApi()
    await load(api)
    fireEvent.click(screen.getByRole('button', { name: '开始泰坦搜索' }))
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: '停止泰坦搜索' })
    expect(vi.mocked(api.start).mock.calls[0][0].settings.sector).toBe('160')
    emit(
      task({
        status: 'success',
        result: {
          status: 'KILL_FOUND',
          mode: 'boss_once',
          region,
          best: { distance: 200, candidate, battle: { seconds: 7.25, boss_killed: true } },
          trials: 3,
        },
      }),
    )
    fireEvent.change(screen.getByLabelText('区域'), { target: { value: '165' } })
    expect(screen.getByText('160 · 表象域 · 首领击杀')).toBeDefined()
    expect(screen.getByRole('heading', { name: '首领击杀配置' })).toBeDefined()
    expect(screen.getByText('7.25 秒')).toBeDefined()
    expect(vi.mocked(api.start).mock.calls[0][0].settings.sector).toBe('160')
  })
})

describe('Titan result evidence', () => {
  it('does not promote a short screen result to an accepted recommendation', () => {
    render(
      <TitanResult
        task={task({
          status: 'no_result',
          result: { status: 'NO_STABLE_RESULT_WITHIN_BUDGET', mode: 'farm_distance', region, trials: 12, best: null },
        })}
      />,
    )
    expect(screen.getByRole('heading', { name: '当前预算内没有已验证推荐' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '已验证挂机配置' })).toBeNull()
    expect(screen.getByText(/已完成 12 次试验/)).toBeDefined()
  })

  it('shows each independent long-farm validation and ordered array targets', () => {
    const checks = [1000003, 2000036, 3000069].map(seed => ({
      seed,
      battle: { seconds: 120, colossal_kills: 10, deaths: 0, minimum_shield_fraction: 0.875 },
    }))
    render(
      <TitanResult
        task={task({
          status: 'success',
          request: { player, settings: { ...settings, mode: 'farm_distance' } },
          result: {
            status: 'BEST_VALIDATED_DISTANCE_FOUND',
            mode: 'farm_distance',
            region,
            trials: 18,
            best: { distance: 199, candidate, validation: checks },
          },
        })}
      />,
    )
    expect(screen.getByRole('heading', { name: '已验证挂机配置' })).toBeDefined()
    expect(screen.getByText('3 次')).toBeDefined()
    expect(screen.getAllByRole('row')).toHaveLength(4)
    for (const seed of checks.map(check => check.seed))
      expect(screen.getByRole('cell', { name: String(seed) })).toBeDefined()
    expect(screen.getAllByRole('cell', { name: '87.5%' })).toHaveLength(3)
    expect(screen.getByText('防护 1')).toBeDefined()
  })
})

it('prevents edits during a pending profile save and unlocks the saved profile afterwards', async () => {
  const { api } = mockApi()
  let finishSave!: (value: TitanPlayer) => void
  vi.mocked(api.savePlayer).mockImplementationOnce(
    () =>
      new Promise<TitanPlayer>(resolve => {
        finishSave = resolve
      }),
  )
  await load(api)
  fireEvent.click(screen.getByRole('tab', { name: '玩家档案' }))
  const damage = screen.getByLabelText('统计总览 · 泰坦伤害') as HTMLInputElement
  fireEvent.change(damage, { target: { value: '5.25e23' } })
  confirmCapture()
  fireEvent.click(screen.getByRole('button', { name: '保存玩家档案' }))
  await waitFor(() => expect(api.savePlayer).toHaveBeenCalledTimes(1))
  expect(damage.matches(':disabled')).toBe(true)
  expect(screen.getByLabelText('泰坦玩家 JSON').matches(':disabled')).toBe(true)
  await userEvent.type(damage, '999')
  expect(damage.value).toBe('5.25e23')
  const saved = vi.mocked(api.savePlayer).mock.calls[0][0]
  await act(async () => {
    finishSave(structuredClone(saved))
  })
  await screen.findByText('玩家档案已保存。切换搜索目标不会改变档案。')
  expect(damage.matches(':disabled')).toBe(false)
  expect(Number(damage.value)).toBe(5.25e23)
})

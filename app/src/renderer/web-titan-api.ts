import { DEFAULT_TITAN_SETTINGS, titanPlayerSchema, titanSettingsSchema } from '../shared/titan'
import type { TitanApi, TitanPlayer, TitanSettings } from '../shared/titan'

const KEY = 'fleet-manager-web-titan-v1'
export function createBrowserTitanApi(): TitanApi {
  let player: TitanPlayer | null = null
  let settings: TitanSettings = { ...DEFAULT_TITAN_SETTINGS }
  let importError: string | undefined
  try {
    const stored = localStorage.getItem(KEY)
    if (stored) {
      const value = JSON.parse(stored)
      player = value.player ? titanPlayerSchema.parse(value.player) : null
      settings = titanSettingsSchema.parse(value.settings)
    }
  } catch {
    importError = '浏览器泰坦档案读取失败，请核对后重新保存。'
  }
  const persist = () => localStorage.setItem(KEY, JSON.stringify({ player, settings }))
  const desktopOnly = async (): Promise<never> => {
    throw new Error('请在桌面应用中运行原生泰坦搜索或读取区域资料。')
  }
  return {
    load: async () => structuredClone({ player, settings, playerSource: player ? 'manager' : 'none', importError }),
    savePlayer: async value => {
      player = titanPlayerSchema.parse(value)
      persist()
      return structuredClone(player)
    },
    saveSettings: async value => {
      settings = titanSettingsSchema.parse(value)
      persist()
      return structuredClone(settings)
    },
    inspect: desktopOnly,
    start: desktopOnly,
    current: async () => null,
    stop: desktopOnly,
    onTask: () => () => {},
  }
}

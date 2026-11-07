import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installWindowUnloadConfirmation } from '../src/main/services/window-unload'

function setup(answer: number) {
  const webContents = new EventEmitter()
  const window = { webContents } as unknown as BrowserWindow
  const confirm = vi.fn(() => answer)
  installWindowUnloadConfirmation(window, confirm)
  return { webContents, window, confirm }
}

describe('desktop unsaved changes confirmation', () => {
  it('keeps the window open when the user cancels and defaults to keeping drafts', () => {
    const { webContents, window, confirm } = setup(0)
    const preventDefault = vi.fn()
    webContents.emit('will-prevent-unload', { preventDefault })
    expect(confirm).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        buttons: ['取消', '放弃修改并继续'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }),
    )
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('allows Electron to close or reload after an explicit discard choice', () => {
    const { webContents } = setup(1)
    const preventDefault = vi.fn()
    webContents.emit('will-prevent-unload', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('does not display a dialog when no renderer blocks unloading', () => {
    const { webContents, confirm } = setup(1)
    webContents.emit('did-finish-load')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not discard changes for a dismissed or unexpected dialog response', () => {
    const { webContents } = setup(-1)
    const preventDefault = vi.fn()
    webContents.emit('will-prevent-unload', { preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

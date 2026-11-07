import type { BrowserWindow, MessageBoxSyncOptions } from 'electron'

type ConfirmUnload = (window: BrowserWindow, options: MessageBoxSyncOptions) => number

export function installWindowUnloadConfirmation(window: BrowserWindow, confirm: ConfirmUnload) {
  window.webContents.on('will-prevent-unload', event => {
    const response = confirm(window, {
      type: 'warning',
      title: '有未保存的修改',
      message: '是否放弃未保存的修改并继续？',
      detail: '选择“取消”可返回应用保存。继续会丢弃尚未保存的修改。',
      buttons: ['取消', '放弃修改并继续'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    // Electron cancels silently by default. Preventing this event permits unload
    // only after the user explicitly chooses to discard the unsaved changes.
    if (response === 1) event.preventDefault()
  })
}

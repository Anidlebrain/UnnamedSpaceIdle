import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { DataRepository } from './services/data-repository'
import { OptimizerRunner } from './services/optimizer-runner'
import type { Selection } from '../shared/contracts'
import { nodeConfigSchema } from '../shared/schemas'

if (process.env.FLEET_MANAGER_USER_DATA_DIR) { app.setPath('userData', process.env.FLEET_MANAGER_USER_DATA_DIR); app.disableHardwareAcceleration() }

const projectRoot = app.getAppPath()
const mainUrl = import.meta.url
const mainDirectory = dirname(fileURLToPath(mainUrl))
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', mainUrl))
const dataRoot = app.isPackaged ? join(app.getPath('userData'), 'fleet-manager-data') : join(projectRoot, 'data')
const repo = new DataRepository(dataRoot, join(projectRoot, '..', 'fleetSimulation', 'map'))
let window: BrowserWindow | undefined
const runner = new OptimizerRunner(repo, join(projectRoot, '..', 'fleetSimulation'), line => window?.webContents.send('optimizer:output', line))
function createWindow() {
  if (is.dev) console.info('[preload-path]', { preloadPath, exists: existsSync(preloadPath), mainUrl, mainDirectory })
  window = new BrowserWindow({ width: 1500, height: 980, minWidth: 1080, minHeight: 720, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false } })
  window.webContents.on('preload-error', (_event, failedPreloadPath, error) => console.error('[preload-error]', failedPreloadPath, error))
  if (is.dev) window.webContents.once('did-finish-load', () => { void window?.webContents.executeJavaScript('Boolean(window.fleetManager)').then(ready => console.info('[preload-bridge]', { ready })).catch(error => console.error('[preload-bridge-error]', error)) })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(mainDirectory, '../renderer/index.html'))
}
app.whenReady().then(() => { ipcMain.handle('data:preview-import', () => repo.previewImport()); ipcMain.handle('data:import', () => repo.importMap()); ipcMain.handle('data:catalog', () => repo.catalog()); ipcMain.handle('data:load', (_, selection: Selection) => repo.load(selection)); ipcMain.handle('data:save', (_, selection: Selection, node: unknown) => repo.save(selection, nodeConfigSchema.parse(node))); ipcMain.handle('optimizer:run', (_, selection: Selection) => runner.run(selection)); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) }); app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

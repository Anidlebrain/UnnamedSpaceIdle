import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { DataRepository } from './services/data-repository'
import { OptimizerRunner } from './services/optimizer-runner'
import { GalaxyRerunService } from './services/galaxy-rerun'
import type { CreateNodeRequest, SearchTaskRequest, Selection } from '../shared/contracts'
import { commonConfigSchema, nodeConfigSchema, optimizerConfigSchema, searchConfigSchema } from '../shared/schemas'

if (process.env.FLEET_MANAGER_USER_DATA_DIR) {
  app.setPath('userData', process.env.FLEET_MANAGER_USER_DATA_DIR)
  app.disableHardwareAcceleration()
}

const projectRoot = app.getAppPath()
const mainUrl = import.meta.url
const mainDirectory = dirname(fileURLToPath(mainUrl))
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', mainUrl))
const dataRoot = app.isPackaged ? join(app.getPath('userData'), 'fleet-manager-data') : join(projectRoot, 'data')
const repo = new DataRepository(dataRoot, join(projectRoot, '..', 'fleetSimulation', 'map'))
let window: BrowserWindow | undefined
const runner = new OptimizerRunner(
  repo,
  join(projectRoot, '..', 'fleetSimulation'),
  (line, taskId) => window?.webContents.send('optimizer:output', { line, taskId }),
  undefined,
  task => window?.webContents.send('optimizer:task', task),
)
const galaxyRerun = new GalaxyRerunService(repo, runner, progress =>
  window?.webContents.send('galaxy-rerun:progress', progress),
)
function createWindow() {
  if (is.dev) console.info('[preload-path]', { preloadPath, exists: existsSync(preloadPath), mainUrl, mainDirectory })
  window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.on('preload-error', (_event, failedPreloadPath, error) =>
    console.error('[preload-error]', failedPreloadPath, error),
  )
  if (is.dev)
    window.webContents.once('did-finish-load', () => {
      void window?.webContents
        .executeJavaScript('Boolean(window.fleetManager)')
        .then(ready => console.info('[preload-bridge]', { ready }))
        .catch(error => console.error('[preload-bridge-error]', error))
    })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(mainDirectory, '../renderer/index.html'))
}
app.whenReady().then(() => {
  ipcMain.handle('data:preview-import', () => repo.previewImport())
  ipcMain.handle('data:import', () => repo.importMap())
  ipcMain.handle('data:catalog', () => repo.catalog())
  ipcMain.handle('data:load', (_, selection: Selection) => repo.load(selection))
  ipcMain.handle('data:load-optimizer-config', () => repo.loadOptimizerConfig())
  ipcMain.handle('data:load-search-config', () => repo.loadSearchConfig())
  ipcMain.handle('data:config-sources', () => repo.configSources())
  ipcMain.handle('data:save', (_, selection: Selection, node: unknown) => {
    runner.assertNodeWritable(selection)
    return repo.save(selection, nodeConfigSchema.parse(node))
  })
  ipcMain.handle('data:save-search-config', (_, search: unknown) =>
    repo.saveSearchConfig(searchConfigSchema.parse(search)),
  )
  ipcMain.handle('data:save-common', (_, selection: Selection, common: unknown) => {
    runner.assertCommonWritable(selection)
    return repo.saveCommon(selection, commonConfigSchema.parse(common))
  })
  ipcMain.handle('data:save-optimizer-config', (_, config: unknown) => {
    runner.assertOptimizerWritable()
    return repo.saveOptimizerConfig(optimizerConfigSchema.parse(config))
  })
  ipcMain.handle('version:create', (_, selection: Selection, name: string) => repo.createVersion(selection, name))
  ipcMain.handle('version:rename', (_, selection: Selection, name: string) => repo.renameVersion(selection, name))
  ipcMain.handle('version:delete', (_, selection: Selection) => {
    runner.assertNodeWritable(selection)
    return repo.deleteVersion(selection)
  })
  ipcMain.handle('version:set-default', (_, selection: Selection) => repo.setDefaultVersion(selection))
  ipcMain.handle('common:create', (_, selection: Selection, name: string) => repo.createCommon(selection, name))
  ipcMain.handle('common:rename', (_, selection: Selection, name: string) => repo.renameCommon(selection, name))
  ipcMain.handle('common:delete', (_, selection: Selection) => {
    runner.assertCommonWritable(selection)
    return repo.deleteCommon(selection)
  })
  ipcMain.handle('common:set-default', (_, selection: Selection) => repo.setDefaultCommon(selection))
  ipcMain.handle('template:create', (_, selection: Selection, name: string) => repo.createTemplate(selection, name))
  ipcMain.handle('template:rename', (_, id: string, name: string) => repo.renameTemplate(id, name))
  ipcMain.handle('template:delete', (_, id: string) => repo.deleteTemplate(id))
  ipcMain.handle('node:create', (_, request: CreateNodeRequest) => repo.createNode(request))
  ipcMain.handle('optimizer:run', (_, request: SearchTaskRequest) =>
    runner.run({ ...request, search: searchConfigSchema.parse(request.search) }),
  )
  ipcMain.handle('optimizer:rerun-galaxy', (_, galaxy: string) => galaxyRerun.run(galaxy))
  ipcMain.handle('optimizer:use-best', (_, taskId: string) => runner.useBest(taskId))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

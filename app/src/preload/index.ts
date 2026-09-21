import { contextBridge, ipcRenderer } from 'electron'
import type { FleetManagerApi } from '../shared/contracts'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'

const isDevelopment = process.env.NODE_ENV === 'development'
if (isDevelopment) console.info('[preload] started')
const api: FleetManagerApi = {
  runtime: 'desktop',
  previewImport: () => ipcRenderer.invoke('data:preview-import'),
  importMap: () => ipcRenderer.invoke('data:import'),
  catalog: () => ipcRenderer.invoke('data:catalog'),
  load: selection => ipcRenderer.invoke('data:load', selection),
  loadOptimizerConfig: () => ipcRenderer.invoke('data:load-optimizer-config'),
  save: (selection, node) => ipcRenderer.invoke('data:save', selection, node),
  saveCommon: (selection, common) => ipcRenderer.invoke('data:save-common', selection, common),
  saveOptimizerConfig: config => ipcRenderer.invoke('data:save-optimizer-config', config),
  createVersion: (selection, name) => ipcRenderer.invoke('version:create', selection, name),
  renameVersion: (selection, name) => ipcRenderer.invoke('version:rename', selection, name),
  deleteVersion: selection => ipcRenderer.invoke('version:delete', selection),
  setDefaultVersion: selection => ipcRenderer.invoke('version:set-default', selection),
  createCommon: (selection, name) => ipcRenderer.invoke('common:create', selection, name),
  renameCommon: (selection, name) => ipcRenderer.invoke('common:rename', selection, name),
  deleteCommon: selection => ipcRenderer.invoke('common:delete', selection),
  setDefaultCommon: selection => ipcRenderer.invoke('common:set-default', selection),
  createTemplate: (selection, name) => ipcRenderer.invoke('template:create', selection, name),
  renameTemplate: (id, name) => ipcRenderer.invoke('template:rename', id, name),
  deleteTemplate: id => ipcRenderer.invoke('template:delete', id),
  createNode: request => ipcRenderer.invoke('node:create', request),
  run: selection => ipcRenderer.invoke('optimizer:run', selection),
  rerunGalaxy: galaxy => ipcRenderer.invoke('optimizer:rerun-galaxy', galaxy),
  useBest: selection => ipcRenderer.invoke('optimizer:use-best', selection),
  onOutput: listener => {
    const handler = (_: Electron.IpcRendererEvent, line: string) => listener(line)
    ipcRenderer.on('optimizer:output', handler)
    return () => ipcRenderer.removeListener('optimizer:output', handler)
  },
  onGalaxyProgress: listener => {
    const handler = (_: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
    ipcRenderer.on('galaxy-rerun:progress', handler)
    return () => ipcRenderer.removeListener('galaxy-rerun:progress', handler)
  },
}
contextBridge.exposeInMainWorld(FLEET_MANAGER_BRIDGE_NAME, api)
if (isDevelopment) console.info('[preload] fleetManager exposed')

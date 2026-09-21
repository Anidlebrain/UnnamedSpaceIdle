import { contextBridge, ipcRenderer } from 'electron'
import type { FleetManagerApi } from '../shared/contracts'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'

const isDevelopment = process.env.NODE_ENV === 'development'
if (isDevelopment) console.info('[preload] started')
const api: FleetManagerApi = { previewImport: () => ipcRenderer.invoke('data:preview-import'), importMap: () => ipcRenderer.invoke('data:import'), catalog: () => ipcRenderer.invoke('data:catalog'), load: selection => ipcRenderer.invoke('data:load', selection), save: (selection, node) => ipcRenderer.invoke('data:save', selection, node), run: selection => ipcRenderer.invoke('optimizer:run', selection), onOutput: listener => { const handler = (_: Electron.IpcRendererEvent, line: string) => listener(line); ipcRenderer.on('optimizer:output', handler); return () => ipcRenderer.removeListener('optimizer:output', handler) } }
contextBridge.exposeInMainWorld(FLEET_MANAGER_BRIDGE_NAME, api)
if (isDevelopment) console.info('[preload] fleetManager exposed')

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'
import { App } from './App'
import { createBrowserApi } from './web-runtime-api'
import '../../tokens.css'
import './styles.css'
import './phase4.css'

if (!window[FLEET_MANAGER_BRIDGE_NAME]) {
  window[FLEET_MANAGER_BRIDGE_NAME] = createBrowserApi()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

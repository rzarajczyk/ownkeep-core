import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { bootstrapI18n } from './i18n'
import { registerAppShellServiceWorker } from './offline/registerSw'
import App from './App.tsx'

bootstrapI18n()
registerAppShellServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

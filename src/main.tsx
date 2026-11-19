import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { initAssistantConfig } from './services/assistantConfig.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
void initAssistantConfig()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { isPopupView } from './extensionViews.js'

if (isPopupView(window)) document.documentElement.classList.add('extension-popup')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

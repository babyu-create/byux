import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/reset.css';
import App from './App';
import { applyTheme, loadTheme } from './lib/theme';

// Apply persisted theme before first render to prevent FOUC.
applyTheme(loadTheme(), undefined);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

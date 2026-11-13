// The page's entry: the stylesheet, the theme before the first paint, and the application.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';
import { applyTheme, storedTheme } from './theme';

applyTheme(storedTheme());
createRoot(document.getElementById('app') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

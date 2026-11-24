import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

try {
  const savedTheme = localStorage.getItem('agentcast_theme');
  document.documentElement.dataset.theme = savedTheme || 'braun';
} catch {
  document.documentElement.dataset.theme = 'braun';
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

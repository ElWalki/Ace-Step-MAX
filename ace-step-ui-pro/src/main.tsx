import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ResponsiveProvider } from './context/ResponsiveContext';
import { InfoPanelProvider } from './context/InfoPanelContext';
import ErrorBoundary from './components/ui/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <ResponsiveProvider>
          <InfoPanelProvider>
            <App />
          </InfoPanelProvider>
        </ResponsiveProvider>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

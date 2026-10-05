import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/** Metadata shown in the informational panel for the currently focused/hovered parameter. */
export interface ParamInfo {
  label: string;
  description?: string;
  value?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

interface InfoPanelControls {
  /** Whether the informational panel is visible. */
  enabled: boolean;
  setEnabled: (b: boolean) => void;
  toggle: () => void;
  /** Report the parameter currently under the cursor / focus. */
  showInfo: (info: ParamInfo) => void;
  /** Clear the active parameter. */
  clearInfo: () => void;
  /** Subscribe to active-info changes (used only by the panel to avoid re-rendering fields). */
  subscribe: (cb: () => void) => () => void;
  getActive: () => ParamInfo | null;
}

const STORAGE_KEY = 'prodia_info_panel';
const InfoPanelContext = createContext<InfoPanelControls | null>(null);

export function InfoPanelProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const activeRef = useRef<ParamInfo | null>(null);
  const listeners = useRef(new Set<() => void>());
  const notify = () => { listeners.current.forEach(l => l()); };

  const showInfo = useCallback((info: ParamInfo) => { activeRef.current = info; notify(); }, []);
  const clearInfo = useCallback(() => { activeRef.current = null; notify(); }, []);
  const subscribe = useCallback((cb: () => void) => {
    listeners.current.add(cb);
    return () => { listeners.current.delete(cb); };
  }, []);
  const getActive = useCallback(() => activeRef.current, []);

  const setEnabled = useCallback((b: boolean) => {
    setEnabledState(b);
    try { localStorage.setItem(STORAGE_KEY, b ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const toggle = useCallback(() => setEnabled(!enabledRef.current), [setEnabled]);

  const value = useMemo<InfoPanelControls>(() => ({
    enabled, setEnabled, toggle, showInfo, clearInfo, subscribe, getActive,
  }), [enabled, setEnabled, toggle, showInfo, clearInfo, subscribe, getActive]);

  return <InfoPanelContext.Provider value={value}>{children}</InfoPanelContext.Provider>;
}

/** Safe accessor for field components — returns null if used outside the provider. */
export function useInfoPanelOptional(): InfoPanelControls | null {
  return useContext(InfoPanelContext);
}

/** Accessor for components that require the provider (panel, toggle button). */
export function useInfoPanel(): InfoPanelControls {
  const ctx = useContext(InfoPanelContext);
  if (!ctx) throw new Error('useInfoPanel must be used within an InfoPanelProvider');
  return ctx;
}

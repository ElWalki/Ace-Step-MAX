import React, { useEffect, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useInfoPanel } from '../../context/InfoPanelContext';

/**
 * Persistent informational panel. When enabled, it shows the label, description,
 * live value and valid range of the parameter currently hovered or focused.
 * Fed by the shared field components (SliderField / SelectField / ToggleField).
 */
export default function InfoPanel() {
  const { t } = useTranslation();
  const { enabled, subscribe, getActive } = useInfoPanel();
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => subscribe(force), [subscribe]);

  if (!enabled) return null;
  const active = getActive();

  const fmt = (v: number | string | boolean | undefined) => {
    if (typeof v === 'boolean') return v ? t('common.on', 'On') : t('common.off', 'Off');
    return String(v);
  };

  return (
    <div className="rounded-lg bg-surface-100/80 border border-accent-500/25 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <Info className="w-3 h-3 text-accent-400 shrink-0" />
        <span className="text-[9px] font-semibold uppercase tracking-wider text-accent-400">
          {t('info.title', 'Parameter info')}
        </span>
      </div>
      {active ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-surface-900 truncate">{active.label}</span>
            {active.value !== undefined && (
              <span className="text-xs font-bold text-accent-400 tabular-nums shrink-0">
                {fmt(active.value)}{active.unit || ''}
              </span>
            )}
          </div>
          {active.description && (
            <p className="text-[11px] text-surface-600 leading-snug mt-0.5">{active.description}</p>
          )}
          {active.min !== undefined && active.max !== undefined && (
            <p className="text-[10px] text-surface-400 mt-1 tabular-nums">
              {t('info.range', 'Range')}: {active.min} – {active.max}
              {active.step !== undefined ? ` · ${t('info.step', 'step')} ${active.step}` : ''}
            </p>
          )}
        </>
      ) : (
        <p className="text-[11px] text-surface-400 leading-snug">
          {t('info.hint', 'Hover or focus a parameter to see its explanation, current value and range.')}
        </p>
      )}
    </div>
  );
}

import React from 'react';
import { useInfoPanelOptional } from '../../context/InfoPanelContext';
import HelpTip from './HelpTip';

interface ToggleFieldProps {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tooltip?: string;
}

export default function ToggleField({ label, value, onChange, disabled, tooltip }: ToggleFieldProps) {
  const info = useInfoPanelOptional();
  const report = () => info?.showInfo({ label, description: tooltip, value });
  return (
    <div className="flex items-center justify-between" onMouseEnter={report} onFocusCapture={report}>
      <label className="text-xs text-surface-500 flex items-center gap-1">
        {label}
        {tooltip && <HelpTip text={tooltip} />}
      </label>
      <button
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          value ? 'bg-accent-500' : 'bg-surface-300'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            value ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

import React from 'react';
import { useInfoPanelOptional } from '../../context/InfoPanelContext';
import HelpTip from './HelpTip';

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  tooltip?: string;
}

export default function SelectField({ label, value, onChange, options, disabled, tooltip }: SelectFieldProps) {
  const info = useInfoPanelOptional();
  const report = () => info?.showInfo({ label, description: tooltip, value: options.find(o => o.value === value)?.label ?? value });
  return (
    <div className="flex items-center gap-3" onMouseEnter={report} onFocusCapture={report}>
      <label className="text-xs text-surface-500 w-24 flex-shrink-0 flex items-center gap-1">
        {label}
        {tooltip && <HelpTip text={tooltip} />}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="flex-1 bg-surface-100 border border-surface-300 rounded-lg px-2 py-1.5 text-xs text-surface-900 focus:ring-1 focus:ring-accent-500"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

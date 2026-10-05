import React, { useState, useRef, useCallback } from 'react';
import { useInfoPanelOptional } from '../../context/InfoPanelContext';
import HelpTip from './HelpTip';

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  tooltip?: string;
}

export default function SliderField({ label, value, onChange, min, max, step = 1, suffix, disabled, tooltip }: SliderFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [localValue, setLocalValue] = useState(value);
  const isDragging = useRef(false);
  const rafRef = useRef(0);
  const info = useInfoPanelOptional();

  const report = useCallback((v: number) => {
    info?.showInfo({ label, description: tooltip, value: step < 1 ? Number(v.toFixed(2)) : v, min, max, step, unit: suffix });
  }, [info, label, tooltip, min, max, step, suffix]);

  // Sync external value when not dragging
  if (!isDragging.current && localValue !== value) {
    setLocalValue(value);
  }

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setLocalValue(v);
    report(v);
    isDragging.current = true;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      onChange(v);
    });
  }, [onChange, report]);

  const handleSliderEnd = useCallback(() => {
    isDragging.current = false;
    cancelAnimationFrame(rafRef.current);
    onChange(localValue);
  }, [onChange, localValue]);

  const handleDoubleClick = () => {
    setEditValue(String(value));
    setIsEditing(true);
  };

  const commitEdit = () => {
    const parsed = parseFloat(editValue);
    if (!isNaN(parsed)) {
      onChange(Math.max(min, Math.min(max, parsed)));
    }
    setIsEditing(false);
  };

  return (
    <div className="flex items-center gap-3" onMouseEnter={() => report(localValue)} onFocusCapture={() => report(localValue)}>
      <label className="text-xs text-surface-500 w-24 flex-shrink-0 flex items-center gap-1">
        {label}
        {tooltip && <HelpTip text={tooltip} />}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onChange={handleSliderChange}
        onMouseUp={handleSliderEnd}
        onTouchEnd={handleSliderEnd}
        disabled={disabled}
        className="flex-1 h-1"
      />
      {isEditing ? (
        <input
          type="number"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => e.key === 'Enter' && commitEdit()}
          className="w-16 text-xs text-right bg-surface-200 border border-surface-300 rounded px-1 py-0.5 text-surface-900"
          autoFocus
        />
      ) : (
        <span
          onDoubleClick={handleDoubleClick}
          className="w-16 text-xs text-right text-surface-700 cursor-pointer tabular-nums shrink-0"
          title="Double-click to edit"
        >
          {step < 1 ? localValue.toFixed(2) : localValue}{suffix || ''}
        </span>
      )}
    </div>
  );
}

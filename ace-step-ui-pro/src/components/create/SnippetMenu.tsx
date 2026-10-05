import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Bookmark, Save, Trash2 } from 'lucide-react';
import DropdownPortal from '../ui/DropdownPortal';

export interface Snippet { name: string; value: string; }

interface SnippetMenuProps {
  title: string;
  snippets: Snippet[];
  currentValue: string;
  onSave: (name: string, value: string) => void;
  onDelete: (name: string) => void;
  onApply: (value: string) => void;
  className?: string;
}

// Save/load menu for a single text field (prompt, style or lyrics).
export default function SnippetMenu({ title, snippets, currentValue, onSave, onDelete, onApply, className = '' }: SnippetMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const trimmedName = name.trim();
  const exists = !!trimmedName && snippets.some(s => s.name === trimmedName);
  const canSave = !!currentValue.trim();

  const doSave = () => {
    if (!canSave) return;
    onSave(trimmedName || `${title} ${snippets.length + 1}`, currentValue);
    setName('');
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`p-1 rounded transition-colors pointer-events-auto ${
          open || snippets.length > 0
            ? 'text-accent-400 bg-accent-500/15 hover:bg-accent-500/25'
            : 'text-surface-500 hover:text-surface-700 hover:bg-surface-200'
        } ${className}`}
        title={title}
      >
        <Bookmark className="w-3.5 h-3.5" />
      </button>
      {open && (
        <DropdownPortal anchorEl={btnRef.current} width={264} align="right" onClose={() => setOpen(false)}>
          <div className="px-3 py-1.5 border-b border-surface-300/40 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider">{title}</span>
            {snippets.length > 0 && <span className="text-[10px] text-surface-400">{snippets.length}</span>}
          </div>
          <div className="px-3 py-2 border-b border-surface-300/40">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('create.snippetName', 'Name...')}
                className="flex-1 min-w-0 bg-surface-200 rounded-md px-2 py-1 text-xs text-surface-900 placeholder:text-surface-400"
                onKeyDown={e => e.key === 'Enter' && doSave()}
              />
              <button
                onClick={doSave}
                disabled={!canSave}
                className={`p-1.5 rounded-md text-white transition-colors disabled:opacity-40 ${
                  exists ? 'bg-amber-500 hover:bg-amber-400' : 'bg-accent-500 hover:bg-accent-400'
                }`}
                title={!canSave
                  ? t('create.snippetEmptyField', 'Write something in the field first')
                  : exists ? t('create.snippetOverwrite', 'Will overwrite the existing entry') : t('create.snippetSave', 'Save current text')}
              >
                <Save className="w-3 h-3" />
              </button>
            </div>
            {exists && (
              <p className="text-[10px] text-amber-400 mt-1">{t('create.snippetOverwrite', 'Will overwrite the existing entry')}</p>
            )}
          </div>
          <div className="max-h-56 overflow-y-auto">
            {snippets.length === 0 ? (
              <p className="px-3 py-3 text-xs text-surface-400 text-center">{t('create.noSnippets', 'Nothing saved yet')}</p>
            ) : snippets.map(s => (
              <div key={s.name} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-200 transition-colors group">
                <button
                  onClick={() => { onApply(s.value); setOpen(false); }}
                  className="flex-1 min-w-0 text-left"
                  title={s.value.length > 220 ? `${s.value.slice(0, 220)}…` : s.value}
                >
                  <span className="block text-xs text-surface-800 font-medium truncate">{s.name}</span>
                  <span className="block text-[10px] text-surface-400 truncate">{s.value.split('\n')[0]}</span>
                </button>
                <button
                  onClick={() => onDelete(s.name)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                  title={t('create.snippetDelete', 'Delete')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </DropdownPortal>
      )}
    </>
  );
}

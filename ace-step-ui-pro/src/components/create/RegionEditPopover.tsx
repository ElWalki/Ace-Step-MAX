import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Wand2, Sparkles, GripHorizontal } from 'lucide-react';

interface RegionEditPopoverProps {
  /** Element the balloon is anchored to (the clip waveform). */
  anchorEl: HTMLElement;
  startLabel: string;
  endLabel: string;
  /** Selection as a fraction of the whole track (0-1), for the mini timeline. */
  regionStart: number;
  regionEnd: number;
  initialPrompt: string;
  initialLyrics: string;
  onCancel: () => void;
  onSubmit: (prompt: string, lyrics: string) => void;
}

const WIDTH = 320;

/**
 * Floating "balloon" to edit the prompt / lyrics for a selected region of a clip
 * and regenerate just that section (repaint). Rendered in a portal and positioned
 * relative to the anchor, re-computed on scroll/resize.
 */
export default function RegionEditPopover({
  anchorEl, startLabel, endLabel, regionStart, regionEnd, initialPrompt, initialLyrics, onCancel, onSubmit,
}: RegionEditPopoverProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [lyrics, setLyrics] = useState(initialLyrics);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const draggedRef = useRef(false);

  // Position below the anchor, clamped to the viewport; flip above if not enough room.
  useLayoutEffect(() => {
    const compute = () => {
      if (draggedRef.current) return; // user moved the balloon — keep their position
      const r = anchorEl.getBoundingClientRect();
      let left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8));
      let top = r.bottom + 8;
      const estH = ref.current?.offsetHeight || 300;
      if (top + estH > window.innerHeight - 8) {
        top = Math.max(8, r.top - estH - 8);
      }
      setPos({ left, top });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorEl]);

  // Close on Escape or click outside (ignoring clicks on the anchor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !anchorEl.contains(target)) onCancel();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onCancel, anchorEl]);

  // Drag the balloon by its header. Once moved, it stops following the anchor.
  const onHeaderDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // ignore the close button
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const base = pos ?? { left: 0, top: 0 };
    const onMove = (ev: MouseEvent) => {
      draggedRef.current = true;
      setPos({
        left: Math.max(8, Math.min(base.left + (ev.clientX - startX), window.innerWidth - WIDTH - 8)),
        top: Math.max(8, Math.min(base.top + (ev.clientY - startY), window.innerHeight - 60)),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const node = (
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: WIDTH }}
      className="z-[80] rounded-xl bg-surface-50 border border-surface-300 shadow-2xl shadow-black/40
        ring-1 ring-black/10 p-3 space-y-2.5 animate-scale-in"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <div
        onMouseDown={onHeaderDown}
        className="flex items-center justify-between -mx-3 -mt-3 px-3 pt-3 pb-2 cursor-move select-none"
      >
        <h4 className="text-xs font-semibold text-surface-900 flex items-center gap-1.5">
          <GripHorizontal className="w-3.5 h-3.5 text-surface-400" />
          <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
          {t('region.title', 'Regenerate section')}
        </h4>
        <button onClick={onCancel} className="text-surface-400 hover:text-surface-700 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Selected zone over the whole track (fuchsia) */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px]">
          <span className="tabular-nums text-fuchsia-500 font-semibold">{startLabel} – {endLabel}</span>
          <span className="text-surface-400">{t('region.ofTrack', 'selected zone')}</span>
        </div>
        <div className="relative h-2 rounded-full bg-surface-200 overflow-hidden ring-1 ring-surface-300/50">
          <div
            className="absolute top-0 h-full bg-fuchsia-500 rounded-full"
            style={{
              left: `${Math.max(0, Math.min(1, regionStart)) * 100}%`,
              width: `${Math.max(0, Math.min(1, regionEnd - regionStart)) * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-medium text-surface-500">
          {t('region.prompt', 'Style / what to change')}
        </label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={2}
          placeholder={t('region.promptPlaceholder', 'e.g. add a saxophone solo, softer drums…')}
          className="w-full text-xs rounded-lg bg-surface-100 border border-surface-300 px-2 py-1.5
            text-surface-800 resize-none outline-none focus:border-accent-500/60"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-medium text-surface-500">{t('region.lyrics', 'Lyrics')}</label>
        <textarea
          value={lyrics}
          onChange={e => setLyrics(e.target.value)}
          rows={4}
          placeholder={t('region.lyricsPlaceholder', 'Song lyrics — edit the lines for this section…')}
          className="w-full text-xs rounded-lg bg-surface-100 border border-surface-300 px-2 py-1.5
            text-surface-800 resize-none outline-none focus:border-accent-500/60 font-mono leading-snug"
        />
        <p className="text-[9px] text-surface-400">
          {t('region.lyricsHint', 'Only this section is regenerated; the rest of the song stays.')}
        </p>
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={onCancel}
          className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-surface-300
            text-surface-600 hover:bg-surface-100 transition-colors"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          onClick={() => onSubmit(prompt, lyrics)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
            bg-accent-500 text-white hover:bg-accent-400 transition-colors font-medium"
        >
          <Wand2 className="w-3 h-3" />
          {t('region.regenerate', 'Regenerate')}
        </button>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

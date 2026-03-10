import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Music, Play, Square, Plus, Sparkles, ChevronDown, ChevronUp, Trash2,
  Piano, X, Save, FolderOpen, ArrowLeft, ArrowRight, Zap, FileAudio, Type,
  Edit3, Loader2,
} from 'lucide-react';
import type { ChordProgressionState, ScaleType, ProgressionMood, ChordInjectionMode, ChordApplyData } from '../../types';
import {
  resolveProgression, resolveChord, parseRoman, CHORD_PRESETS, AVAILABLE_KEYS,
  ChordAudioEngine, formatProgressionForGeneration, renderProgressionToWav,
} from '../../services/chordService';
import type { ResolvedChord } from '../../services/chordService';
import PianoRollModal from './PianoRollModal';

interface ChordEditorProps {
  value: ChordProgressionState;
  onChange: (state: ChordProgressionState) => void;
  onApply?: (data: ChordApplyData) => void;
}

interface PlacedChord {
  id: string;
  roman: string;
  octaveShift: number;
  /** Duration in beats (default = beatsPerChord from parent) */
  beats?: number;
}

const QUICK_CHORDS_MAJOR = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const QUICK_CHORDS_MINOR = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

const MOOD_LABELS: Record<ProgressionMood, { label: string; emoji: string }> = {
  romantic: { label: 'Romantic', emoji: '💕' },
  dark: { label: 'Dark', emoji: '🌑' },
  upbeat: { label: 'Upbeat', emoji: '⚡' },
  jazz: { label: 'Jazz', emoji: '🎷' },
  latin: { label: 'Latin', emoji: '🔥' },
  lofi: { label: 'Lo-Fi', emoji: '☕' },
  epic: { label: 'Epic', emoji: '🎬' },
  folk: { label: 'Folk', emoji: '🪕' },
};

let _pcId = 0;
const uid = () => `pc-${++_pcId}-${Date.now()}`;

export default function ChordEditor({ value, onChange, onApply }: ChordEditorProps) {
  const { t } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [presetMood, setPresetMood] = useState<ProgressionMood>('romantic');
  const [formatMode, setFormatMode] = useState<'roman' | 'letter'>('roman');
  const [showPianoRoll, setShowPianoRoll] = useState(false);

  // Injection mode
  const [injectionMode, setInjectionMode] = useState<ChordInjectionMode>('style');
  const [isRendering, setIsRendering] = useState(false);

  // Piano roll voicing edit
  const [editingChordIdx, setEditingChordIdx] = useState<number | null>(null);

  // DnD state
  const [placedChords, setPlacedChords] = useState<PlacedChord[]>([]);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingFrom, setDraggingFrom] = useState<'palette' | 'timeline' | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [deleteHover, setDeleteHover] = useState(false);

  const lastSyncedRoman = useRef<string>('');
  const engineRef = useRef<ChordAudioEngine | null>(null);

  useEffect(() => {
    return () => { engineRef.current?.dispose(); };
  }, []);

  const getEngine = useCallback(() => {
    if (!engineRef.current) engineRef.current = new ChordAudioEngine();
    return engineRef.current;
  }, []);

  // ── Saved progression sequences (localStorage) ────────────────────
  interface SavedSequence {
    name: string;
    key: string;
    scale: ScaleType;
    bpm: number;
    beatsPerChord: number;
    chords: PlacedChord[];
  }
  const SEQUENCES_KEY = 'acestep_chord_sequences';
  const [savedSequences, setSavedSequences] = useState<SavedSequence[]>(() => {
    try { return JSON.parse(localStorage.getItem(SEQUENCES_KEY) || '[]'); } catch { return []; }
  });
  const [showSequences, setShowSequences] = useState(false);
  const [sequenceName, setSequenceName] = useState('');

  const saveSequence = useCallback(() => {
    const name = sequenceName.trim() || `Seq ${savedSequences.length + 1}`;
    const seq: SavedSequence = {
      name, key: value.key, scale: value.scale, bpm: value.bpm,
      beatsPerChord: value.beatsPerChord, chords: placedChords,
    };
    const updated = [...savedSequences.filter(s => s.name !== name), seq];
    setSavedSequences(updated);
    localStorage.setItem(SEQUENCES_KEY, JSON.stringify(updated));
    setSequenceName('');
    setShowSequences(false);
  }, [sequenceName, savedSequences, value, placedChords]);

  const loadSequence = useCallback((seq: SavedSequence) => {
    onChange({ key: seq.key, scale: seq.scale, bpm: seq.bpm, beatsPerChord: seq.beatsPerChord, roman: seq.chords.map(c => c.roman).join(' - ') });
    setPlacedChords(seq.chords.map(c => ({ ...c, id: uid() })));
    setShowSequences(false);
  }, [onChange]);

  const deleteSequence = useCallback((name: string) => {
    const updated = savedSequences.filter(s => s.name !== name);
    setSavedSequences(updated);
    localStorage.setItem(SEQUENCES_KEY, JSON.stringify(updated));
  }, [savedSequences]);

  // Sync parent → internal (presets, manual input, external changes)
  useEffect(() => {
    if (value.roman !== lastSyncedRoman.current) {
      const slots = value.roman.split(/\s*-\s*/).filter(Boolean);
      setPlacedChords(slots.map(r => ({ id: uid(), roman: r.trim(), octaveShift: 0 })));
      lastSyncedRoman.current = value.roman;
    }
  }, [value.roman]);

  // Sync internal → parent
  const syncToParent = useCallback((chords: PlacedChord[]) => {
    const roman = chords.map(c => c.roman).join(' - ');
    lastSyncedRoman.current = roman;
    onChange({ ...value, roman });
  }, [value, onChange]);

  const resolved = useMemo(
    () => resolveProgression(value.roman, value.key, value.scale),
    [value.roman, value.key, value.scale],
  );

  // Resolve with per-chord octave shifts for preview
  const resolvedPlaced = useMemo(() =>
    placedChords.map(pc => {
      const token = parseRoman(pc.roman);
      const chord = resolveChord(token, value.key, value.scale);
      if (pc.octaveShift !== 0) {
        return {
          ...chord,
          notes: chord.notes.map(n => n + pc.octaveShift * 12),
          rootMidi: chord.rootMidi + pc.octaveShift * 12,
        };
      }
      return chord;
    }),
    [placedChords, value.key, value.scale],
  );

  const quickChords = value.scale === 'minor' ? QUICK_CHORDS_MINOR : QUICK_CHORDS_MAJOR;

  // ── Chord operations ─────────────────────────────────────────────
  const insertChordAt = useCallback((index: number, roman: string) => {
    const updated = [...placedChords];
    updated.splice(index, 0, { id: uid(), roman, octaveShift: 0 });
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const addChord = useCallback((roman: string) => {
    insertChordAt(placedChords.length, roman);
  }, [insertChordAt, placedChords.length]);

  const removeChord = useCallback((index: number) => {
    const updated = placedChords.filter((_, i) => i !== index);
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const moveChord = useCallback((fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const updated = [...placedChords];
    const [moved] = updated.splice(fromIdx, 1);
    const dest = toIdx > fromIdx ? toIdx - 1 : toIdx;
    updated.splice(dest, 0, moved);
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const moveChordLeft = useCallback((index: number) => {
    if (index <= 0) return;
    const updated = [...placedChords];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const moveChordRight = useCallback((index: number) => {
    if (index >= placedChords.length - 1) return;
    const updated = [...placedChords];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const updateChordRoman = useCallback((index: number, roman: string) => {
    const updated = [...placedChords];
    updated[index] = { ...updated[index], roman };
    setPlacedChords(updated);
    syncToParent(updated);
  }, [placedChords, syncToParent]);

  const setOctaveShift = useCallback((index: number, shift: number) => {
    setPlacedChords(prev => prev.map((pc, i) =>
      i === index ? { ...pc, octaveShift: Math.max(-2, Math.min(2, shift)) } : pc,
    ));
  }, []);

  // ── Audio handlers ────────────────────────────────────────────────
  const handlePreviewChord = useCallback((notes: number[]) => {
    getEngine().playChord(notes, 0.5);
  }, [getEngine]);

  const playStopRef = useRef(false);

  const handlePlay = useCallback(async () => {
    if (isPlaying) { playStopRef.current = true; getEngine().stop(); setIsPlaying(false); setPlayingIdx(-1); return; }
    if (resolvedPlaced.length === 0) return;
    playStopRef.current = false;
    setIsPlaying(true);
    const beatDur = 60 / value.bpm;
    for (let i = 0; i < resolvedPlaced.length; i++) {
      if (playStopRef.current) break;
      setPlayingIdx(i);
      const chordBeats = placedChords[i]?.beats ?? value.beatsPerChord;
      getEngine().playChord(resolvedPlaced[i].notes, beatDur * chordBeats * 0.9);
      await new Promise(r => setTimeout(r, beatDur * chordBeats * 1000));
    }
    setIsPlaying(false);
    setPlayingIdx(-1);
  }, [isPlaying, resolvedPlaced, placedChords, value.bpm, value.beatsPerChord, getEngine]);

  const handleApply = useCallback(async () => {
    const textData = formatProgressionForGeneration(value.roman, value.key, value.scale);
    if (injectionMode === 'style') {
      onApply?.({ mode: 'style', ...textData });
      return;
    }
    // Audio modes — render progression to WAV
    if (resolvedPlaced.length === 0) return;
    setIsRendering(true);
    try {
      const chordBeats = placedChords.map(pc => pc.beats ?? value.beatsPerChord);
      const blob = await renderProgressionToWav(resolvedPlaced, value.bpm, value.beatsPerChord, chordBeats);
      onApply?.({ mode: injectionMode, ...textData, audioBlob: blob });
    } catch (err) {
      console.error('Failed to render chord audio:', err);
    } finally {
      setIsRendering(false);
    }
  }, [value, injectionMode, onApply, resolvedPlaced, placedChords]);

  const handlePresetSelect = useCallback((preset: typeof CHORD_PRESETS[0]) => {
    onChange({
      key: preset.key,
      scale: preset.scale,
      roman: preset.roman,
      bpm: value.bpm,
      beatsPerChord: value.beatsPerChord,
    });
    setShowPresets(false);
  }, [onChange, value.bpm, value.beatsPerChord]);

  const handlePianoRollAdd = useCallback((_notes: number[], label: string) => {
    if (editingChordIdx !== null && editingChordIdx < placedChords.length) {
      // Update existing chord voicing
      updateChordRoman(editingChordIdx, label);
      setEditingChordIdx(null);
    } else {
      addChord(label);
    }
  }, [addChord, editingChordIdx, placedChords.length, updateChordRoman]);

  // ── DnD handlers ─────────────────────────────────────────────────
  const onPaletteDragStart = useCallback((e: React.DragEvent, chord: string) => {
    e.dataTransfer.setData('text/chord-palette', chord);
    e.dataTransfer.effectAllowed = 'copy';
    setDraggingFrom('palette');
  }, []);

  const onTimelineDragStart = useCallback((e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/chord-index', String(index));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingFrom('timeline');
    setDraggingIndex(index);
  }, []);

  const onDragEnd = useCallback(() => {
    setDraggingFrom(null);
    setDraggingIndex(null);
    setDropIndex(null);
    setDeleteHover(false);
  }, []);

  // Compute insertion index from cursor position inside the timeline container
  const timelineRef = useRef<HTMLDivElement>(null);
  const computeDropIndex = useCallback((e: React.DragEvent) => {
    const container = timelineRef.current;
    if (!container) return placedChords.length;
    const chordEls = container.querySelectorAll('[data-chord-idx]');
    for (const el of chordEls) {
      const idx = parseInt((el as HTMLElement).dataset.chordIdx!, 10);
      // Skip the element being dragged — it's still in DOM but visually dimmed
      if (draggingIndex !== null && idx === draggingIndex) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) return idx;
    }
    return placedChords.length;
  }, [placedChords.length, draggingIndex]);

  const onTimelineDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = draggingFrom === 'palette' ? 'copy' : 'move';
    setDropIndex(computeDropIndex(e));
  }, [draggingFrom, computeDropIndex]);

  const onTimelineDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the container itself
    if (timelineRef.current && !timelineRef.current.contains(e.relatedTarget as Node)) {
      setDropIndex(null);
    }
  }, []);

  const onTimelineDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const idx = computeDropIndex(e);
    const fromPalette = e.dataTransfer.getData('text/chord-palette');
    if (fromPalette) insertChordAt(idx, fromPalette);
    const reIdx = e.dataTransfer.getData('text/chord-index');
    if (reIdx !== '') moveChord(parseInt(reIdx, 10), idx);
    setDropIndex(null);
    setDraggingFrom(null);
    setDraggingIndex(null);
  }, [computeDropIndex, insertChordAt, moveChord]);

  const onDeleteOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDeleteHover(true);
  }, []);

  const onDeleteDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const idx = e.dataTransfer.getData('text/chord-index');
    if (idx !== '') removeChord(parseInt(idx, 10));
    setDeleteHover(false);
    setDraggingFrom(null);
    setDraggingIndex(null);
  }, [removeChord]);

  // Per-chord beat duration setter
  const setChordBeats = useCallback((index: number, beats: number) => {
    setPlacedChords(prev => prev.map((pc, i) =>
      i === index ? { ...pc, beats: Math.max(0.5, Math.min(8, beats)) } : pc,
    ));
  }, []);

  // Playing highlight index
  const [playingIdx, setPlayingIdx] = useState(-1);

  return (
    <div className="space-y-3">
      {/* ── Key / Scale / Format ────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={value.key}
          onChange={e => onChange({ ...value, key: e.target.value })}
          className="bg-surface-100 border border-surface-300 rounded-lg px-2 py-1.5 text-xs text-surface-900 w-16"
        >
          {AVAILABLE_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>

        <div className="flex rounded-lg overflow-hidden border border-surface-300">
          {(['major', 'minor'] as ScaleType[]).map(s => (
            <button
              key={s}
              onClick={() => onChange({ ...value, scale: s })}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                value.scale === s ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
              }`}
            >
              {s === 'major' ? t('chords.major', 'Major') : t('chords.minor', 'Minor')}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg overflow-hidden border border-surface-300 ml-auto">
          <button
            onClick={() => setFormatMode('roman')}
            className={`px-2 py-1.5 text-xs font-medium transition-colors ${
              formatMode === 'roman' ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
            }`}
            title="Roman numerals"
          >I-IV-V</button>
          <button
            onClick={() => setFormatMode('letter')}
            className={`px-2 py-1.5 text-xs font-medium transition-colors ${
              formatMode === 'letter' ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
            }`}
            title="Letter names"
          >C-Am-G</button>
        </div>
      </div>

      {/* ── Chord Palette (drag source) ────────── */}
      <div className="rounded-xl border border-surface-300 bg-surface-50 p-2 space-y-1.5">
        <span className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">
          {t('chords.palette', 'Chord Palette')}
        </span>
        <div className="flex flex-wrap gap-1">
          {quickChords.map(c => {
            const token = parseRoman(c);
            const rc = resolveChord(token, value.key, value.scale);
            return (
              <button
                key={c}
                draggable
                onDragStart={e => onPaletteDragStart(e, c)}
                onDragEnd={onDragEnd}
                onClick={() => handlePreviewChord(rc.notes)}
                className="px-2.5 py-1.5 rounded-lg bg-surface-100 border border-surface-300 text-xs
                  text-surface-700 hover:bg-accent-500/10 hover:text-accent-400 hover:border-accent-500/30
                  active:scale-95 transition-all cursor-grab active:cursor-grabbing select-none"
                title={`${c} (${rc.name}) — click to preview, drag to place`}
              >
                <span className="font-bold">{c}</span>
                <span className="ml-1 text-[10px] text-surface-400">{rc.name}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {['7', 'maj7', 'sus2', 'sus4'].map(q => (
            <button
              key={q}
              onClick={() => {
                if (placedChords.length > 0) {
                  const updated = [...placedChords];
                  const last = updated[updated.length - 1];
                  updated[updated.length - 1] = { ...last, roman: last.roman + q };
                  setPlacedChords(updated);
                  syncToParent(updated);
                }
              }}
              className="px-2 py-1 rounded-md bg-surface-150 text-[10px] text-surface-500
                hover:bg-brand-500/10 hover:text-brand-400 transition-colors"
            >
              +{q}
            </button>
          ))}
          <button
            onClick={() => setShowPianoRoll(true)}
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-surface-150 text-[10px]
              text-surface-500 hover:bg-accent-500/10 hover:text-accent-400 transition-colors"
            title={t('chords.pianoRollBtn', 'Custom chord via Piano Roll')}
          >
            <Piano className="w-3 h-3" />
            {t('chords.pianoRoll', 'Piano Roll')}
          </button>
        </div>
      </div>

      {/* ── Progression Timeline (intuitive drop target with ghost preview) ────────── */}
      <div className="rounded-xl border border-surface-300 bg-surface-50 p-2">
        <div className="flex items-center gap-1 mb-2">
          <span className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">
            {t('chords.progression', 'Progression')}
          </span>
          <span className="text-[10px] text-surface-400 ml-auto">
            {placedChords.length} {t('chords.chordsCount', 'chords')}
          </span>
        </div>

        <div
          ref={timelineRef}
          onDragOver={onTimelineDragOver}
          onDragLeave={onTimelineDragLeave}
          onDrop={onTimelineDrop}
          className="flex items-stretch gap-1 overflow-x-auto pb-1 min-h-[84px]"
        >
          {placedChords.length === 0 && !draggingFrom && (
            <div className="flex-1 flex items-center justify-center py-4 text-xs text-surface-400 italic">
              {t('chords.dragHint', 'Drag chords here or click palette to add')}
            </div>
          )}

          {placedChords.length === 0 && draggingFrom && (
            <>
              {/* Ghost preview when timeline is empty */}
              <div className="flex flex-col items-center px-3 py-2 rounded-lg border-2 border-dashed
                border-accent-500/40 bg-accent-500/10 min-w-[56px] animate-pulse">
                <span className="text-xs font-bold text-accent-400/60">?</span>
                <span className="text-[9px] text-accent-400/40 mt-1">Drop here</span>
              </div>
            </>
          )}

          {resolvedPlaced.map((chord, i) => {
            const pc = placedChords[i];
            if (!pc) return null;
            const isDragging = draggingIndex === i;
            const isPlaying = playingIdx === i;
            const chordBeats = pc.beats ?? value.beatsPerChord;
            // Show ghost BEFORE this chord if dropIndex matches
            const showGhostBefore = dropIndex === i && draggingFrom;
            // If dragging from timeline, skip ghost at source position
            const skipGhost = draggingFrom === 'timeline' && draggingIndex === i;

            return (
              <React.Fragment key={pc.id}>
                {/* Ghost preview — translucent blue block that shifts existing chords */}
                {showGhostBefore && !skipGhost && (
                  <div className="flex flex-col items-center px-3 py-2 rounded-lg border-2 border-dashed
                    border-accent-500/50 bg-accent-500/10 min-w-[56px] shrink-0 transition-all duration-150">
                    <span className="text-xs font-bold text-accent-400/60">
                      {draggingFrom === 'palette' ? '?' : resolvedPlaced[draggingIndex!]?.roman || '?'}
                    </span>
                    <span className="text-[9px] text-accent-400/40 mt-1">
                      {draggingFrom === 'palette' ? 'New' : resolvedPlaced[draggingIndex!]?.name || ''}
                    </span>
                  </div>
                )}

                <div
                  data-chord-idx={i}
                  draggable
                  onDragStart={e => onTimelineDragStart(e, i)}
                  onDragEnd={onDragEnd}
                  onClick={() => handlePreviewChord(chord.notes)}
                  className={`relative flex flex-col items-center px-3 py-2 rounded-lg border
                    min-w-[56px] group select-none cursor-grab active:cursor-grabbing shrink-0
                    transition-all duration-150
                    ${isDragging ? 'opacity-20 scale-90' : ''}
                    ${isPlaying
                      ? 'border-accent-500 bg-accent-500/15 shadow-[0_0_12px_theme(colors.accent.500/30)] scale-105'
                      : 'hover:border-accent-500/50 hover:bg-surface-100 bg-surface-100 border-surface-300'
                    }`}
                >
                  {/* X delete */}
                  <button
                    onClick={e => { e.stopPropagation(); removeChord(i); }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white
                      flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                      hover:bg-red-400 z-10"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>

                  {/* Edit voicing button */}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setEditingChordIdx(i);
                      setShowPianoRoll(true);
                    }}
                    className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-brand-500 text-white
                      flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                      hover:bg-brand-400 z-10"
                    title={t('chords.editVoicing', 'Edit voicing')}
                  >
                    <Edit3 className="w-2.5 h-2.5" />
                  </button>

                  <span className="text-xs font-bold text-accent-400">
                    {formatMode === 'roman' ? chord.roman : chord.name}
                  </span>
                  <span className="text-[9px] text-surface-500">
                    {formatMode === 'roman' ? chord.name : chord.roman}
                  </span>

                  {/* Beat count badge */}
                  <div className="flex items-center gap-0.5 mt-0.5">
                    <button
                      onClick={e => { e.stopPropagation(); setChordBeats(i, chordBeats - 0.5); }}
                      className="w-3 h-3 rounded flex items-center justify-center text-surface-400
                        hover:text-accent-400 hover:bg-accent-500/10 transition-colors text-[8px]"
                    >−</button>
                    <span className="text-[8px] font-mono text-surface-400 min-w-[18px] text-center">
                      {chordBeats}b
                    </span>
                    <button
                      onClick={e => { e.stopPropagation(); setChordBeats(i, chordBeats + 0.5); }}
                      className="w-3 h-3 rounded flex items-center justify-center text-surface-400
                        hover:text-accent-400 hover:bg-accent-500/10 transition-colors text-[8px]"
                    >+</button>
                  </div>

                  {/* Octave control */}
                  <div className="flex items-center gap-0.5 mt-0.5">
                    <button
                      onClick={e => { e.stopPropagation(); setOctaveShift(i, pc.octaveShift - 1); }}
                      disabled={pc.octaveShift <= -2}
                      className="w-3.5 h-3.5 rounded flex items-center justify-center
                        text-surface-400 hover:text-accent-400 hover:bg-accent-500/10
                        disabled:opacity-20 transition-colors"
                    >
                      <ChevronDown className="w-2.5 h-2.5" />
                    </button>
                    {pc.octaveShift !== 0 && (
                      <span className="text-[8px] font-mono text-accent-400 min-w-[14px] text-center">
                        {pc.octaveShift > 0 ? `+${pc.octaveShift}` : pc.octaveShift}
                      </span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); setOctaveShift(i, pc.octaveShift + 1); }}
                      disabled={pc.octaveShift >= 2}
                      className="w-3.5 h-3.5 rounded flex items-center justify-center
                        text-surface-400 hover:text-accent-400 hover:bg-accent-500/10
                        disabled:opacity-20 transition-colors"
                    >
                      <ChevronUp className="w-2.5 h-2.5" />
                    </button>
                  </div>

                  {/* Move arrows */}
                  <div className="flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={e => { e.stopPropagation(); moveChordLeft(i); }}
                      disabled={i === 0}
                      className="w-4 h-4 rounded flex items-center justify-center text-surface-400
                        hover:text-accent-400 hover:bg-accent-500/10 disabled:opacity-20 transition-colors"
                      title={t('chords.moveLeft', 'Move left')}
                    >
                      <ArrowLeft className="w-2.5 h-2.5" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); moveChordRight(i); }}
                      disabled={i === placedChords.length - 1}
                      className="w-4 h-4 rounded flex items-center justify-center text-surface-400
                        hover:text-accent-400 hover:bg-accent-500/10 disabled:opacity-20 transition-colors"
                      title={t('chords.moveRight', 'Move right')}
                    >
                      <ArrowRight className="w-2.5 h-2.5" />
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

          {/* Ghost at end of timeline */}
          {dropIndex === placedChords.length && draggingFrom && (
            <div className="flex flex-col items-center px-3 py-2 rounded-lg border-2 border-dashed
              border-accent-500/50 bg-accent-500/10 min-w-[56px] shrink-0 transition-all duration-150">
              <span className="text-xs font-bold text-accent-400/60">
                {draggingFrom === 'palette' ? '?' : resolvedPlaced[draggingIndex!]?.roman || '?'}
              </span>
              <span className="text-[9px] text-accent-400/40 mt-1">
                {draggingFrom === 'palette' ? 'New' : resolvedPlaced[draggingIndex!]?.name || ''}
              </span>
            </div>
          )}
        </div>

        {/* Delete zone — visible only while dragging from timeline */}
        {draggingFrom === 'timeline' && (
          <div
            onDragOver={onDeleteOver}
            onDragLeave={() => setDeleteHover(false)}
            onDrop={onDeleteDrop}
            className={`mt-2 py-2 rounded-lg border-2 border-dashed flex items-center justify-center gap-1.5
              text-xs transition-all ${
                deleteHover
                  ? 'border-red-500 bg-red-500/10 text-red-400'
                  : 'border-surface-300 text-surface-400'
              }`}
          >
            <Trash2 className="w-3 h-3" />
            {t('chords.dropToDelete', 'Drop here to remove')}
          </div>
        )}
      </div>

      {/* ── Manual input ────────── */}
      <input
        value={value.roman}
        onChange={e => onChange({ ...value, roman: e.target.value })}
        placeholder="I - V - vi - IV"
        className="w-full bg-surface-100 border border-surface-300 rounded-lg px-3 py-1.5 text-xs
          text-surface-900 placeholder:text-surface-400 font-mono"
      />

      {/* ── Injection Mode Selector ────────── */}
      <div className="rounded-xl border border-surface-300 bg-surface-50 p-2">
        <span className="text-[10px] font-medium text-surface-500 uppercase tracking-wider mb-1.5 block">
          {t('chords.injectionMode', 'Injection Mode')}
        </span>
        <div className="flex gap-1">
          {([
            { mode: 'style' as const, icon: Type, label: t('chords.modeStyle', 'Style Text'), desc: t('chords.modeStyleDesc', 'Add to style prompt as text') },
            { mode: 'audioCodes' as const, icon: Zap, label: t('chords.modeCodes', 'Audio Codes'), desc: t('chords.modeCodesDesc', 'Inject as latent audio codes (strongest)') },
            { mode: 'reference' as const, icon: FileAudio, label: t('chords.modeRef', 'Reference Audio'), desc: t('chords.modeRefDesc', 'Use as reference audio for timbre/style') },
          ] as const).map(({ mode, icon: Icon, label, desc }) => (
            <button
              key={mode}
              onClick={() => setInjectionMode(mode)}
              className={`flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-center
                transition-all ${
                  injectionMode === mode
                    ? 'border-accent-500 bg-accent-500/10 text-accent-400 shadow-[0_0_8px_theme(colors.accent.500/20)]'
                    : 'border-surface-300 bg-surface-100 text-surface-500 hover:bg-surface-200 hover:border-surface-400'
                }`}
              title={desc}
            >
              <Icon className="w-4 h-4" />
              <span className="text-[10px] font-medium leading-tight">{label}</span>
            </button>
          ))}
        </div>
        {injectionMode !== 'style' && (
          <p className="text-[9px] text-surface-400 mt-1.5 leading-snug">
            {injectionMode === 'audioCodes'
              ? t('chords.codesHint', '⚡ Renders chord audio → extracts semantic tokens → guides generation at latent level')
              : t('chords.refHint', '🎵 Renders chord audio → uses as reference → model matches timbre & harmonic structure')
            }
          </p>
        )}
      </div>

      {/* ── Controls ────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-surface-500">{t('chords.beats', 'Beats')}:</span>
          {[1, 2, 4].map(b => (
            <button
              key={b}
              onClick={() => onChange({ ...value, beatsPerChord: b })}
              className={`w-6 h-6 rounded text-xs font-medium transition-colors ${
                value.beatsPerChord === b
                  ? 'bg-accent-500 text-white'
                  : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
              }`}
            >
              {b}
            </button>
          ))}
        </div>

        <button
          onClick={handlePlay}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
            isPlaying
              ? 'bg-red-500/10 text-red-400 border border-red-500/30'
              : 'bg-accent-500/10 text-accent-400 border border-accent-500/30 hover:bg-accent-500/20'
          }`}
        >
          {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          {isPlaying ? t('chords.stop', 'Stop') : t('chords.preview', 'Preview')}
        </button>

        <button
          onClick={() => setShowPresets(!showPresets)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
            bg-surface-100 text-surface-500 border border-surface-300 hover:bg-surface-200
            transition-colors ml-auto"
        >
          <Sparkles className="w-3 h-3" />
          {t('chords.presets', 'Presets')}
          <ChevronDown className={`w-3 h-3 transition-transform ${showPresets ? 'rotate-180' : ''}`} />
        </button>

        <button
          onClick={() => setShowSequences(!showSequences)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
            bg-surface-100 text-surface-500 border border-surface-300 hover:bg-surface-200 transition-colors"
          title={t('chords.sequences', 'Saved Sequences')}
        >
          <FolderOpen className="w-3 h-3" />
        </button>

        {onApply && (
          <button
            onClick={handleApply}
            disabled={resolved.length === 0 || isRendering}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
              bg-gradient-to-r from-accent-600 to-brand-600 text-white
              hover:from-accent-500 hover:to-brand-500 disabled:opacity-40 transition-all"
          >
            {isRendering ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : injectionMode === 'audioCodes' ? (
              <Zap className="w-3 h-3" />
            ) : injectionMode === 'reference' ? (
              <FileAudio className="w-3 h-3" />
            ) : (
              <Music className="w-3 h-3" />
            )}
            {isRendering
              ? t('chords.rendering', 'Rendering…')
              : injectionMode === 'style'
                ? t('chords.apply', 'Apply')
                : injectionMode === 'audioCodes'
                  ? t('chords.applyCodes', 'Apply as Codes')
                  : t('chords.applyRef', 'Apply as Reference')
            }
          </button>
        )}
      </div>

      {/* ── Presets browser ────────── */}
      {showPresets && (
        <div className="rounded-xl border border-surface-300 bg-surface-50 overflow-hidden animate-scale-in">
          <div className="flex gap-1 px-2 py-2 overflow-x-auto border-b border-surface-200">
            {(Object.keys(MOOD_LABELS) as ProgressionMood[]).map(mood => (
              <button
                key={mood}
                onClick={() => setPresetMood(mood)}
                className={`px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap transition-colors ${
                  presetMood === mood
                    ? 'bg-accent-500 text-white'
                    : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
                }`}
              >
                {MOOD_LABELS[mood].emoji} {MOOD_LABELS[mood].label}
              </button>
            ))}
          </div>
          <div className="max-h-40 overflow-y-auto p-2 space-y-1">
            {CHORD_PRESETS.filter(p => p.mood === presetMood).map(preset => (
              <button
                key={preset.id}
                onClick={() => handlePresetSelect(preset)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg
                  hover:bg-surface-100 transition-colors text-left group"
              >
                <span className="text-sm">{preset.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-surface-800 truncate">{preset.name}</p>
                  <p className="text-[10px] text-surface-500 font-mono truncate">{preset.roman}</p>
                </div>
                <span className="text-[10px] text-surface-400">{preset.key} {preset.scale}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Saved Sequences Panel ────────── */}
      {showSequences && (
        <div className="rounded-xl border border-surface-300 bg-surface-50 overflow-hidden animate-scale-in">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-200">
            <input
              type="text"
              value={sequenceName}
              onChange={e => setSequenceName(e.target.value)}
              placeholder={t('chords.sequenceName', 'Sequence name…')}
              className="flex-1 min-w-0 px-2 py-1 text-xs rounded-lg bg-surface-100 border border-surface-300
                text-surface-800 placeholder-surface-400 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
            <button
              onClick={saveSequence}
              disabled={!sequenceName.trim() || placedChords.length === 0}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium
                bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Save className="w-3 h-3" />
              {t('chords.save', 'Save')}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto p-2 space-y-1">
            {savedSequences.length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-4">
                {t('chords.noSequences', 'No saved sequences yet')}
              </p>
            ) : (
              savedSequences.map(seq => (
                <div
                  key={seq.name}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-surface-100 transition-colors group"
                >
                  <button
                    onClick={() => loadSequence(seq)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-xs font-medium text-surface-800 truncate">{seq.name}</p>
                    <p className="text-[10px] text-surface-500 truncate">
                      {seq.key} {seq.scale} · {seq.bpm} BPM · {seq.chords.length} chords
                    </p>
                  </button>
                  <button
                    onClick={() => deleteSequence(seq.name)}
                    className="p-1 rounded text-surface-400 hover:text-red-500 hover:bg-red-50
                      opacity-0 group-hover:opacity-100 transition-all"
                    title={t('chords.delete', 'Delete')}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Piano Roll Modal ────────── */}
      <PianoRollModal
        isOpen={showPianoRoll}
        onClose={() => { setShowPianoRoll(false); setEditingChordIdx(null); }}
        onAddChord={handlePianoRollAdd}
        engine={getEngine()}
        bpm={value.bpm}
        initialNotes={editingChordIdx !== null ? resolvedPlaced[editingChordIdx]?.notes : undefined}
        editMode={editingChordIdx !== null}
      />
    </div>
  );
}

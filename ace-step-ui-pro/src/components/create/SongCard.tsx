import React, { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Music, Play, Pause, Loader2, ThumbsUp, ThumbsDown, Share2, Video, ListPlus, MoreVertical, Disc3, Copy, Check, Scissors, ExternalLink, X, Paintbrush, Wand2, MessageSquarePlus, ListMusic } from 'lucide-react';
import type { Song, RegionRegenOptions, RepaintRegionSpec } from '../../types';
import SongContextMenu from '../ui/SongContextMenu';
import RegionEditPopover from './RegionEditPopover';
import { getCoverStyle } from '../../utils/coverArt';
import { useStemProcessing } from '../../hooks/useStemProcessing';

/** Extract short label like 'turbo' | 'sft' | 'base' | 'xl base' | 'xl turbo' | 'turbo shift1' */
function normalizeModel(raw?: string): string {
  if (!raw) return '';
  const l = raw.toLowerCase();
  const isXL = /(^|-)xl(-|$)/.test(l);
  let variant = '';
  if (l.includes('turbo')) variant = 'turbo';
  else if (l.includes('sft')) variant = 'sft';
  else variant = 'base';
  let suffix = '';
  if (l.includes('continuous')) suffix = ' cont.';
  else if (l.includes('shift1')) suffix = ' shift1';
  else if (l.includes('shift3')) suffix = ' shift3';
  return `${isXL ? 'XL ' : ''}${variant}${suffix}`;
}

interface SongCardProps {
  song: Song;
  isPlaying: boolean;
  isCurrent: boolean;
  onPlay: () => void;
  onDelete?: () => void;
  onMenuAction?: (key: string) => void;
  onSelect?: () => void;
  onRename?: (newTitle: string) => void;
  onLike?: () => void;
  audioRef?: React.RefObject<HTMLAudioElement>;
  onCopySeed?: (seed: number) => void;
  onCancelGeneration?: () => void;
  onRegenerateRegion?: (opts: RegionRegenOptions) => void;
  onRegenerateRegions?: (regions: RepaintRegionSpec[]) => void;
}

// Deterministic avatar color from string
function avatarColor(name: string) {
  const colors = ['#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#4f46e5'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

// Deterministic waveform bars from song ID (fallback when audio not decoded yet)
function generateBars(id: string, count: number): number[] {
  const bars: number[] = [];
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    bars.push(0.15 + 0.85 * ((seed >> 16) & 0x7fff) / 0x7fff);
  }
  return bars;
}

// Parse a duration ("m:ss", "h:mm:ss", plain seconds string, or a number) into seconds. 0 if unknown.
function parseDurationSec(d?: string | number | null): number {
  if (d == null) return 0;
  if (typeof d === 'number') return isFinite(d) && d > 0 ? d : 0;
  if (typeof d !== 'string') return 0;
  if (d.includes(':')) {
    const parts = d.split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }
  const n = parseFloat(d);
  return isNaN(n) ? 0 : n;
}

function fmtClipTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Estimated song sections from lyric tags ─────────────────────────────────
// The model generates the full song in ONE diffusion pass (not per-section), so exact
// boundaries aren't available. We estimate them from the [Verse]/[Chorus]/... tags by
// weighting each section's line count over the clip duration — good enough to navigate
// and pre-select a region for repaint.
type SongSection = { name: string; start: number; end: number; color: string };

const SECTION_COLORS: Record<string, string> = {
  intro: '#38bdf8', verse: '#a78bfa', 'pre-chorus': '#fbbf24', prechorus: '#fbbf24',
  chorus: '#f472b6', rap: '#34d399', bridge: '#fb923c', break: '#94a3b8',
  outro: '#60a5fa', hook: '#f472b6', drop: '#ef4444', instrumental: '#64748b', solo: '#2dd4bf',
};

function sectionColor(name: string): string {
  const key = name.toLowerCase().replace(/\s*\d+$/, '').trim();
  return SECTION_COLORS[key] || '#8b5cf6';
}

function estimateSections(lyrics: string | undefined, duration: number): SongSection[] {
  if (!lyrics || duration <= 0) return [];
  const lines = lyrics.split(/\r?\n/);
  const sections: { name: string; lines: number }[] = [];
  let current: { name: string; lines: number } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const tag = line.match(/^\[([^\]]+)\]$/);
    if (tag) {
      if (current) sections.push(current);
      current = { name: tag[1].trim(), lines: 0 };
    } else if (line && current) {
      current.lines += 1;
    }
  }
  if (current) sections.push(current);
  if (sections.length < 2) return [];

  // Weight: every section gets a base weight plus its line count (empty tags still take time)
  const weights = sections.map(s => 2 + s.lines);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return sections.map((s, i) => {
    const span = (weights[i] / totalW) * duration;
    const seg = { name: s.name, start: t, end: Math.min(duration, t + span), color: sectionColor(s.name) };
    t += span;
    return seg;
  });
}

const BAR_COUNT = 500;

/**
 * Cache only the downsampled peaks (BAR_COUNT floats ≈ 2 KB) plus duration — NOT the full
 * decoded AudioBuffer (which can be ~120 MB for a 3-minute stereo song). Storing full buffers
 * for every generated clip is what made the tab run out of memory and crash. Bounded LRU so the
 * cache can never grow without limit.
 */
type WaveformPeaks = { peaks: Float32Array; duration: number };
const WAVEFORM_CACHE_LIMIT = 40;
const waveformPeaksCache = new Map<string, WaveformPeaks>();

function cacheGetPeaks(url: string): WaveformPeaks | undefined {
  const v = waveformPeaksCache.get(url);
  if (v) {
    // Touch for LRU recency
    waveformPeaksCache.delete(url);
    waveformPeaksCache.set(url, v);
  }
  return v;
}

function cacheSetPeaks(url: string, value: WaveformPeaks) {
  waveformPeaksCache.set(url, value);
  while (waveformPeaksCache.size > WAVEFORM_CACHE_LIMIT) {
    const oldest = waveformPeaksCache.keys().next().value;
    if (oldest === undefined) break;
    waveformPeaksCache.delete(oldest);
  }
}

/** Downsample a decoded buffer to BAR_COUNT peak values (0-1). */
function computePeaks(decoded: AudioBuffer): Float32Array {
  const channel = decoded.getChannelData(0);
  const peaks = new Float32Array(BAR_COUNT);
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = Math.floor((i / BAR_COUNT) * channel.length);
    const end = Math.floor(((i + 1) / BAR_COUNT) * channel.length);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j] || 0);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
  }
  return peaks;
}

/** Inline mini waveform – professional DAW-style mirrored bars, seekable via click/drag.
 *  In region mode, drag selects a section (0-1 normalized) instead of seeking. */
function MiniWaveform({ songId, isPlaying, isCurrent, audioUrl, audioRef, regionMode, region, onRegionChange, onDuration }: {
  songId: string; isPlaying: boolean; isCurrent: boolean;
  audioUrl?: string;
  audioRef?: React.RefObject<HTMLAudioElement>;
  regionMode?: boolean;
  region?: { start: number; end: number } | null;
  onRegionChange?: (start: number, end: number) => void;
  onDuration?: (seconds: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(() => generateBars(songId, BAR_COUNT), [songId]);
  const rafRef = useRef<number>(0);
  const activeRef = useRef(false);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  // Decode audio once, keep only the downsampled peaks (tiny) cached by URL.
  useEffect(() => {
    if (!audioUrl) return;

    const cached = cacheGetPeaks(audioUrl);
    if (cached) {
      setPeaks(cached.peaks);
      onDuration?.(cached.duration);
      return;
    }

    let cancelled = false;
    const decode = async () => {
      let audioContext: AudioContext | null = null;
      try {
        const response = await fetch(audioUrl);
        const arr = await response.arrayBuffer();
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const decoded = await audioContext.decodeAudioData(arr);
        const computed = computePeaks(decoded);
        const duration = decoded.duration;
        // Full PCM buffer is dropped here; only `computed` (≈2 KB) survives.
        if (!cancelled) {
          cacheSetPeaks(audioUrl, { peaks: computed, duration });
          setPeaks(computed);
          onDuration?.(duration);
        }
      } catch {
        // Keep fallback bars if decode fails.
      } finally {
        if (audioContext && audioContext.state !== 'closed') {
          audioContext.close().catch(() => { /* ignore */ });
        }
      }
    };

    decode();
    return () => { cancelled = true; };
  }, [audioUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      const barW = w / bars.length;
      const midY = h / 2;
      const maxHalf = h * 0.48;

      let progress = 0;
      if (isCurrent && audioRef?.current) {
        const a = audioRef.current;
        if (a.duration && isFinite(a.duration)) progress = a.currentTime / a.duration;
      }

      const isLight = document.documentElement.classList.contains('light');
      const playedColor = isLight ? 'rgba(99,102,241,0.85)' : 'rgba(139,92,246,0.9)';
      const mutedColor = isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.13)';

      // Dense mirrored columns — real waveform when available, fallback otherwise.
      for (let i = 0; i < bars.length; i++) {
        const x = Math.round(i * barW);
        const nextX = Math.round((i + 1) * barW);
        const colW = Math.max(1, nextX - x);
        // Use precomputed peaks (cheap) instead of scanning raw PCM every frame.
        const halfH = peaks
          ? Math.max(0.5, peaks[i] * maxHalf)
          : Math.max(0.5, bars[i] * maxHalf);

        const pct = (i + 0.5) / bars.length;
        ctx.fillStyle = (isCurrent && progress > 0 && pct <= progress) ? playedColor : mutedColor;
        ctx.fillRect(x, midY - halfH, colW, halfH);
        ctx.fillRect(x, midY, colW, halfH);
      }

      // Playhead
      if (isCurrent && progress > 0) {
        const px = progress * w;
        ctx.fillStyle = isLight ? 'rgba(99,102,241,0.9)' : 'rgba(255,255,255,0.55)';
        ctx.fillRect(Math.round(px) - 0.5, 0, 1, h);
      }
    };

    // Initial draw
    draw();

    // rAF loop — guarded by mutable ref so cleanup always stops it
    activeRef.current = isPlaying;
    if (isPlaying) {
      const loop = () => {
        if (!activeRef.current) return;
        draw();
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    }

    // Redraw on timeupdate when paused but current (shows seek position)
    const audio = audioRef?.current;
    const onTime = () => { if (isCurrent && !activeRef.current) draw(); };
    audio?.addEventListener('timeupdate', onTime);

    // Redraw on resize (e.g. panel drag changes canvas width)
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);

    return () => {
      activeRef.current = false;
      cancelAnimationFrame(rafRef.current);
      audio?.removeEventListener('timeupdate', onTime);
      ro.disconnect();
    };
  }, [songId, isPlaying, isCurrent, audioRef, bars, peaks]);

  // Seek on click/drag
  const handleSeekStart = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isCurrent || !audioRef?.current) return;
    e.stopPropagation();
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || !audio.duration) return;

    const seek = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      audio.currentTime = pct * audio.duration;
    };
    seek(e.clientX);

    const onMove = (ev: MouseEvent) => { seek(ev.clientX); };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [isCurrent, audioRef]);

  // Region select on drag (repaint zone) — reports normalized 0-1 start/end
  const handleRegionStart = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const anchor = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let s = anchor, en = anchor;
    onRegionChange?.(s, en);
    const onMove = (ev: MouseEvent) => {
      const p = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      s = Math.min(anchor, p);
      en = Math.max(anchor, p);
      onRegionChange?.(s, en);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Respect tiny selections exactly as dragged; only discard a pure click (no drag)
      if (en - s < 0.004) onRegionChange?.(0, 0);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onRegionChange]);

  // Drag a selection edge to fine-tune its bounds (the other edge stays anchored)
  const handleEdgeDrag = useCallback((edge: 'start' | 'end') => (e: React.MouseEvent) => {
    if (!region) return;
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const other = edge === 'start' ? region.end : region.start;
    const onMove = (ev: MouseEvent) => {
      const p = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      onRegionChange?.(Math.min(other, p), Math.max(other, p));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [region, onRegionChange]);

  return (
    <div className="relative w-full">
      <canvas
        ref={canvasRef}
        className={`w-full rounded-md transition-all duration-200 ${
          regionMode
            ? 'h-16 ring-1 ring-fuchsia-500/50 shadow-[0_0_12px_rgba(217,70,239,0.15)] bg-black/20'
            : `h-8 ${isCurrent ? 'cursor-pointer hover:ring-1 hover:ring-accent-400/50' : 'cursor-default'}`
        } ${regionMode ? 'cursor-crosshair' : ''}`}
        // Region mode: plain drag = playhead scrub · Ctrl+drag = select · double-click = clear
        onMouseDown={(e) => {
          if (!regionMode) { handleSeekStart(e); return; }
          if (e.ctrlKey || e.metaKey) handleRegionStart(e);
          else handleSeekStart(e);
        }}
        onDoubleClick={(e) => { if (regionMode) { e.stopPropagation(); onRegionChange?.(0, 0); } }}
      />
      {regionMode && region && region.end > region.start && (
        <div
          className="group/region absolute top-0 h-full bg-gradient-to-b from-fuchsia-500/30 to-fuchsia-600/15 border-x-2 border-fuchsia-400 rounded-sm pointer-events-none outline outline-1 outline-transparent hover:outline-fuchsia-300/80 transition-[outline-color]"
          style={{ left: `${region.start * 100}%`, width: `${(region.end - region.start) * 100}%` }}
        >
          {/* Draggable DAW-style grip handles — resize the selection from either edge */}
          <div
            onMouseDown={handleEdgeDrag('start')}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-8 rounded-sm bg-fuchsia-400 shadow-md flex items-center justify-center pointer-events-auto cursor-ew-resize hover:bg-fuchsia-300 hover:scale-x-125 transition-transform"
            title="Arrastra para ajustar el inicio"
          >
            <div className="w-0.5 h-4 bg-fuchsia-900/50 rounded-full" />
          </div>
          <div
            onMouseDown={handleEdgeDrag('end')}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-2.5 h-8 rounded-sm bg-fuchsia-400 shadow-md flex items-center justify-center pointer-events-auto cursor-ew-resize hover:bg-fuchsia-300 hover:scale-x-125 transition-transform"
            title="Arrastra para ajustar el final"
          >
            <div className="w-0.5 h-4 bg-fuchsia-900/50 rounded-full" />
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(function SongCard({ song, isPlaying, isCurrent, onPlay, onDelete, onMenuAction, onSelect, onRename, onLike, audioRef, onCopySeed, onCancelGeneration, onRegenerateRegion, onRegenerateRegions }: SongCardProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [seedCopied, setSeedCopied] = useState(false);
  const [wfHover, setWfHover] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [region, setRegion] = useState<{ start: number; end: number } | null>(null);
  // Committed multi-selection regions (normalized 0-1), each with optional per-region edits
  const [extraRegions, setExtraRegions] = useState<Array<{ start: number; end: number; prompt?: string; lyrics?: string }>>([]);
  const [editRegionIdx, setEditRegionIdx] = useState<number | null>(null);
  const [decodedDur, setDecodedDur] = useState(0);
  const [showBalloon, setShowBalloon] = useState(false);
  const waveformWrapRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Stem processing hook
  const { processing: stemProcessing } = useStemProcessing();
  const isProcessingStem = stemProcessing && (stemProcessing.songId === song.id || stemProcessing.audioUrl === song.audioUrl);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const coverStyle = useMemo(() => getCoverStyle(song.id), [song.id]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRename) {
      setEditTitle(song.title || '');
      setIsEditing(true);
    }
  }, [onRename, song.title]);

  const commitRename = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== song.title && onRename) onRename(trimmed);
    setIsEditing(false);
  }, [editTitle, song.title, onRename]);

  useEffect(() => {
    if (isEditing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditing]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4 });
  }, []);

  const handleAction = useCallback((key: string) => {
    if (key === 'play') { onPlay(); return; }
    if (key === 'delete' && onDelete) { onDelete(); return; }
    onMenuAction?.(key);
  }, [onPlay, onDelete, onMenuAction]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (song.isGenerating || !song.audioUrl) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/song-audio-url', song.audioUrl);
    e.dataTransfer.setData('text/song-title', song.title || 'Untitled');
    e.dataTransfer.setData('text/song-id', song.id);
    e.dataTransfer.effectAllowed = 'copy';
  }, [song]);

  const handleSeedClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const s = song.generationParams?.seed;
    if (s === undefined) return;
    navigator.clipboard.writeText(String(s));
    setSeedCopied(true);
    onCopySeed?.(s);
    setTimeout(() => setSeedCopied(false), 1500);
  }, [song.generationParams?.seed, onCopySeed]);

  const creatorName = song.creator || song.userId || 'User';
  const creatorInitial = creatorName.charAt(0).toUpperCase();
  const ditRaw = song.ditModel || song.generationParams?.ditModel;
  const ditLabel = normalizeModel(ditRaw);
  const loraName = song.generationParams?.loraName;
  const loraScale = song.generationParams?.loraScale;
  const seed = song.generationParams?.seed;
  const inferMethod = song.generationParams?.inferMethod;
  const isVllm = song.generationParams?.lmBackend === 'vllm';
  const clipDuration = decodedDur > 0
    ? decodedDur
    : (isCurrent && audioRef?.current?.duration && isFinite(audioRef.current.duration))
      ? audioRef.current.duration
      : parseDurationSec(song.duration);

  const [showSections, setShowSections] = useState(false);
  const sections = useMemo(
    () => estimateSections(song.lyrics || song.generationParams?.lyrics, clipDuration),
    [song.lyrics, song.generationParams?.lyrics, clipDuration],
  );

  // Regions that were repainted to produce THIS clip (from its generation params)
  const repaintedMarkers = useMemo(() => {
    if (clipDuration <= 0) return [] as Array<{ start: number; end: number }>;
    const gp = song.generationParams;
    if (!gp || gp.taskType !== 'repaint') return [];
    const out: Array<{ start: number; end: number }> = [];
    const regions = (gp as { repaintRegions?: Array<{ start: number; end: number }> }).repaintRegions;
    if (Array.isArray(regions)) {
      for (const r of regions) {
        if (isFinite(r.start) && isFinite(r.end) && r.end > r.start) {
          out.push({ start: Math.max(0, r.start / clipDuration), end: Math.min(1, r.end / clipDuration) });
        }
      }
    } else if (typeof gp.repaintingStart === 'number' && typeof gp.repaintingEnd === 'number' && gp.repaintingEnd > gp.repaintingStart) {
      out.push({ start: Math.max(0, gp.repaintingStart / clipDuration), end: Math.min(1, gp.repaintingEnd / clipDuration) });
    }
    return out;
  }, [song.generationParams, clipDuration]);

  // Region-mode keyboard: Enter commits the live selection, Escape exits the mode
  useEffect(() => {
    if (!regionMode) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'Enter' && region && extraRegions.length < 6) {
        e.preventDefault();
        setExtraRegions(prev => [...prev, { ...region }].sort((a, b) => a.start - b.start));
        setRegion(null);
        setShowBalloon(false);
      } else if (e.key === 'Escape') {
        setRegionMode(false);
        setShowBalloon(false);
        setEditRegionIdx(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [regionMode, region, extraRegions.length]);

  // Click a section block → pre-select it as the repaint region
  const selectSection = useCallback((s: SongSection) => {
    if (clipDuration <= 0) return;
    setRegionMode(true);
    setRegion({ start: s.start / clipDuration, end: s.end / clipDuration });
  }, [clipDuration]);

  return (
    <>
      <div
        draggable={!wfHover && !regionMode && !song.isGenerating && !!song.audioUrl}
        onDragStart={handleDragStart}
        className={`group flex items-start gap-4 px-4 py-4 rounded-xl cursor-pointer transition-all ${
          isCurrent && isPlaying
            ? 'bg-accent-500/15 border border-accent-400/70 ring-1 ring-accent-400/40 shadow-[0_0_0_1px_rgba(168,85,247,0.25)]'
            : isCurrent
            ? 'bg-accent-500/10 border border-accent-500/30'
            : 'hover:bg-surface-100/60 border border-transparent hover:border-surface-300/40'
        }`}
        onClick={() => onSelect?.()}
        onContextMenu={handleContextMenu}
      >
        {/* Thumbnail / play overlay — 64×64 */}
        <div
          className="relative w-16 h-16 rounded-xl flex-shrink-0 overflow-hidden cursor-pointer"
          onClick={(e) => { e.stopPropagation(); if (!song.isGenerating) onPlay(); }}
        >
          {song.coverUrl ? (
            <img src={song.coverUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center" style={coverStyle}>
              {isCurrent && isPlaying ? (
                <Disc3 className="w-6 h-6 text-white/70 animate-spin" />
              ) : (
                <Music className="w-6 h-6 text-white/50" />
              )}
            </div>
          )}
          {song.isGenerating ? (
            <div
              className="absolute inset-0 bg-black/60 flex items-center justify-center cursor-pointer group/cancel"
              onClick={(e) => { e.stopPropagation(); onCancelGeneration?.(); }}
              title="Cancel generation"
            >
              <div className="relative w-7 h-7 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-white/60 animate-spin absolute transition-opacity group-hover/cancel:opacity-0" />
                <X className="w-5 h-5 text-red-400 absolute opacity-0 transition-opacity group-hover/cancel:opacity-100" />
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/45 flex items-center justify-center transition-colors">
              {isCurrent && isPlaying ? (
                <Pause className="w-5 h-5 text-white opacity-0 group-hover:opacity-100" />
              ) : (
                <Play className="w-5 h-5 text-white ml-0.5 opacity-0 group-hover:opacity-100" />
              )}
            </div>
          )}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0 space-y-1">

          {/* Row 1: Title + badges */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {isEditing ? (
              <input
                ref={titleInputRef}
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsEditing(false); }}
                className="text-sm font-bold text-surface-900 bg-surface-100 border border-accent-500/40 rounded px-1 py-0 w-full min-w-0 outline-none select-text"
                onClick={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
              />
            ) : (
              <span
                className="text-sm font-bold text-accent-400 hover:text-accent-300 transition-colors truncate cursor-text"
                onClick={handleTitleClick}
                title={t('create.clickToRename', 'Click to rename')}
              >
                {song.title || 'Untitled'}
              </span>
            )}
            {ditLabel && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gradient-to-r from-violet-500/25 to-accent-500/25 text-violet-300 font-bold shrink-0 leading-none border border-violet-500/30 tracking-wide uppercase" title={ditRaw}>
                {ditLabel}
              </span>
            )}
            {loraName && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-300/30 text-surface-400 font-medium shrink-0 leading-none truncate max-w-[120px]">
                LoRA: {loraName}{loraScale !== undefined && loraScale !== 1 ? ` ×${loraScale.toFixed(1)}` : ''}
              </span>
            )}
            {seed !== undefined && (
              <button
                onClick={handleSeedClick}
                className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-surface-300/20 text-surface-500 font-medium shrink-0 leading-none hover:bg-surface-300/40 hover:text-surface-700 transition-colors cursor-pointer"
                title={t('create.copySeed', 'Click to copy seed')}
              >
                {seedCopied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
                seed: {seed}
              </button>
            )}
            {inferMethod && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-500/15 text-teal-400 font-medium shrink-0 leading-none uppercase">
                {inferMethod}
              </span>
            )}
            {isVllm && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium shrink-0 leading-none">
                vLLM
              </span>
            )}
          </div>

          {/* Row 2: Creator */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); onMenuAction?.('openProfile'); }}
              className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 hover:ring-2 hover:ring-accent-500/50 transition-all cursor-pointer"
              style={{ backgroundColor: avatarColor(creatorName) }}
            >
              {creatorInitial}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onMenuAction?.('openProfile'); }}
              className="text-xs text-surface-500 hover:text-accent-400 transition-colors cursor-pointer"
            >
              {creatorName}
            </button>
          </div>

          {/* Row 3: Style tags */}
          {song.style && (
            <p className="text-xs text-surface-500 leading-snug line-clamp-1">{song.style}</p>
          )}

          {/* Row 4: Waveform + in-clip region regeneration */}
          {!song.isGenerating && song.audioUrl && (
            // Disable the card's drag-to-reference while the pointer is over the waveform so
            // dragging here scrubs/seeks (or selects a region) instead of dragging onto Reference/Cover.
            <div onMouseEnter={() => setWfHover(true)} onMouseLeave={() => setWfHover(false)}>
              {/* Estimated section strip (from lyric tags) — click a block to pre-select it */}
              {showSections && sections.length > 0 && clipDuration > 0 && (
                <div className="relative h-4 mb-0.5 flex rounded-sm overflow-hidden" title={t('create.sectionsEstimated', 'Sections estimated from lyric tags (approximate)')}>
                  {sections.map((s, i) => (
                    <button
                      key={i}
                      onClick={(e) => { e.stopPropagation(); selectSection(s); }}
                      className="group/sec relative h-full border-r border-black/30 last:border-r-0 hover:brightness-125 transition-[filter]"
                      style={{ width: `${((s.end - s.start) / clipDuration) * 100}%`, backgroundColor: `${s.color}55` }}
                      title={`${s.name} · ~${fmtClipTime(s.start)}–${fmtClipTime(s.end)} (estimado)`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold uppercase tracking-tight truncate px-0.5 pointer-events-none" style={{ color: s.color }}>
                        {s.name.length > 12 ? s.name.slice(0, 11) + '…' : s.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div ref={waveformWrapRef} className="relative">
                <MiniWaveform
                  songId={song.id}
                  isPlaying={isPlaying}
                  isCurrent={isCurrent}
                  audioUrl={song.audioUrl}
                  audioRef={audioRef}
                  regionMode={regionMode}
                  region={region}
                  onRegionChange={(s, e) => setRegion(e - s < 0.001 ? null : { start: s, end: e })}
                  onDuration={setDecodedDur}
                />
                {/* Regions repainted in THIS clip's generation — subtle dashed markers */}
                {!regionMode && repaintedMarkers.map((m, i) => (
                  <div
                    key={`rm${i}`}
                    className="absolute top-0 h-full border-x border-dashed border-emerald-400/60 bg-emerald-400/10 rounded-sm pointer-events-none"
                    style={{ left: `${m.start * 100}%`, width: `${(m.end - m.start) * 100}%` }}
                    title={`Sección regenerada: ${fmtClipTime(m.start * clipDuration)}–${fmtClipTime(m.end * clipDuration)}`}
                  >
                    <span className="absolute -top-0.5 left-0.5 text-[7px] font-black text-emerald-400/80">↺</span>
                  </div>
                ))}
                {/* Committed multi-selection overlays — visual only; controls live in the chips row below */}
                {regionMode && extraRegions.map((r, i) => (
                  <div
                    key={i}
                    className="absolute top-0 h-full bg-gradient-to-b from-amber-500/30 to-amber-600/15 border-x-2 border-amber-400 rounded-sm pointer-events-none"
                    style={{ left: `${r.start * 100}%`, width: `${(r.end - r.start) * 100}%` }}
                  >
                    <span className="absolute left-1 top-0.5 text-[9px] font-black text-amber-300 drop-shadow">
                      {i + 1}{(r.prompt || r.lyrics) ? ' ✎' : ''}
                    </span>
                  </div>
                ))}
                {/* Toggle estimated sections strip */}
                {sections.length > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowSections(v => !v); }}
                    className={`absolute -top-2.5 right-7 flex items-center justify-center w-6 h-6 rounded-lg border transition-all ${
                      showSections
                        ? 'bg-sky-500 border-sky-400 text-white shadow-md shadow-sky-500/30'
                        : `bg-surface-200/90 border-surface-300/50 text-surface-500 hover:bg-surface-300 hover:text-surface-800 ${regionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
                    }`}
                    title={t('create.toggleSections', 'Show estimated song sections (intro/verse/chorus…)')}
                  >
                    <ListMusic className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Toggle region-select mode — keeps selections; they only clear on regenerate / × / double-click */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRegionMode(m => !m);
                  }}
                  className={`absolute -top-2.5 right-0 flex items-center justify-center w-6 h-6 rounded-lg border transition-all ${
                    regionMode
                      ? 'bg-accent-500 border-accent-400 text-white shadow-md shadow-accent-500/30'
                      : 'bg-surface-200/90 border-surface-300/50 text-surface-500 opacity-0 group-hover:opacity-100 hover:bg-surface-300 hover:text-surface-800'
                  }`}
                  title={t('create.selectRegion', 'Select a section to regenerate')}
                >
                  <Paintbrush className="w-3.5 h-3.5" />
                </button>
              </div>
              {regionMode && (
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {/* Per-selection chips — controls outside the waveform so nothing covers it */}
                  {extraRegions.map((r, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-500 bg-amber-500/10 border border-amber-400/40 rounded-full pl-2 pr-1 py-0.5 tabular-nums"
                    >
                      <b>{i + 1}</b> {fmtClipTime(r.start * clipDuration)}–{fmtClipTime(r.end * clipDuration)}{(r.prompt || r.lyrics) ? ' ✎' : ''}
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditRegionIdx(i); }}
                        className="w-4 h-4 rounded-full hover:bg-amber-500/20 flex items-center justify-center"
                        title={t('create.editSectionHint', 'Edit the prompt / lyrics for this section')}
                      >
                        <MessageSquarePlus className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setExtraRegions(prev => prev.filter((_, j) => j !== i)); setEditRegionIdx(null); }}
                        className="w-4 h-4 rounded-full text-red-400 hover:bg-red-500/20 flex items-center justify-center"
                        title={t('common.remove', 'Quitar')}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                  <span className={`text-[10px] tabular-nums ${region || extraRegions.length ? 'text-fuchsia-500 font-semibold' : 'text-surface-500'}`}>
                    {region
                      ? (clipDuration > 0
                          ? `${t('create.section', 'Section')} ${fmtClipTime(region.start * clipDuration)}–${fmtClipTime(region.end * clipDuration)}`
                          : `${t('create.section', 'Section')} ${Math.round(region.start * 100)}%–${Math.round(region.end * 100)}%`)
                      : t('create.regionHint', 'Ctrl+arrastrar: seleccionar · Arrastrar: posición · Enter: añadir · Doble click: limpiar')}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {region && extraRegions.length < 6 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          // Commit current drag as a numbered selection and free the cursor for the next one
                          setExtraRegions(prev => [...prev, { ...region }].sort((a, b) => a.start - b.start));
                          setRegion(null);
                          setShowBalloon(false);
                        }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-amber-400/60 text-amber-500 hover:bg-amber-500/10 transition-colors"
                        title={t('create.addSelectionHint', 'Guardar esta selección y marcar otra')}
                      >
                        ＋ {t('create.addSelection', 'Añadir')}
                      </button>
                    )}
                    {region && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowBalloon(true); }}
                        className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border border-surface-300 text-surface-600 hover:bg-surface-100 transition-colors"
                        title={t('create.editSectionHint', 'Edit the prompt / lyrics for this section')}
                      >
                        <MessageSquarePlus className="w-2.5 h-2.5" />
                        {t('create.edit', 'Edit')}
                      </button>
                    )}
                    {(region || extraRegions.length > 0) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const all = [...extraRegions, ...(region ? [{ ...region }] : [])];
                          if (all.length > 1 && onRegenerateRegions) {
                            onRegenerateRegions(all.map(r => ({
                              start: r.start * clipDuration,
                              end: r.end * clipDuration,
                              style: r.prompt,
                              lyrics: r.lyrics,
                            })));
                          } else if (all.length === 1) {
                            const r = all[0] as { start: number; end: number; prompt?: string; lyrics?: string };
                            onRegenerateRegion?.({
                              startSec: r.start * clipDuration,
                              endSec: r.end * clipDuration,
                              prompt: r.prompt,
                              lyrics: r.lyrics,
                            });
                          }
                          setRegionMode(false);
                          setRegion(null);
                          setExtraRegions([]);
                          setShowBalloon(false);
                          setEditRegionIdx(null);
                        }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-accent-500 text-white hover:bg-accent-400 transition-colors"
                        title={t('create.regenerateSectionHint', 'Regenerate only this section, keep the rest')}
                      >
                        <Wand2 className="w-2.5 h-2.5" />
                        {extraRegions.length + (region ? 1 : 0) > 1
                          ? `${t('create.regenerate', 'Regenerar')} ×${extraRegions.length + (region ? 1 : 0)}`
                          : t('create.regenerate', 'Regenerate')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {showBalloon && region && waveformWrapRef.current && (
                <RegionEditPopover
                  anchorEl={waveformWrapRef.current}
                  startLabel={clipDuration > 0 ? fmtClipTime(region.start * clipDuration) : `${Math.round(region.start * 100)}%`}
                  endLabel={clipDuration > 0 ? fmtClipTime(region.end * clipDuration) : `${Math.round(region.end * 100)}%`}
                  regionStart={region.start}
                  regionEnd={region.end}
                  initialPrompt={song.generationParams?.style ?? song.style ?? ''}
                  initialLyrics={song.generationParams?.lyrics ?? song.lyrics ?? ''}
                  onCancel={() => setShowBalloon(false)}
                  onSubmit={(prompt, lyrics) => {
                    if (extraRegions.length > 0) {
                      // Multi-selection in progress → commit this drag with its edits, keep selecting
                      setExtraRegions(prev => [...prev, { ...region, prompt, lyrics }].sort((a, b) => a.start - b.start));
                      setRegion(null);
                      setShowBalloon(false);
                      return;
                    }
                    onRegenerateRegion?.({
                      startSec: region.start * clipDuration,
                      endSec: region.end * clipDuration,
                      prompt,
                      lyrics,
                    });
                    setShowBalloon(false);
                    setRegionMode(false);
                    setRegion(null);
                  }}
                />
              )}
              {editRegionIdx !== null && extraRegions[editRegionIdx] && waveformWrapRef.current && (
                <RegionEditPopover
                  anchorEl={waveformWrapRef.current}
                  startLabel={fmtClipTime(extraRegions[editRegionIdx].start * clipDuration)}
                  endLabel={fmtClipTime(extraRegions[editRegionIdx].end * clipDuration)}
                  regionStart={extraRegions[editRegionIdx].start}
                  regionEnd={extraRegions[editRegionIdx].end}
                  initialPrompt={extraRegions[editRegionIdx].prompt ?? song.generationParams?.style ?? song.style ?? ''}
                  initialLyrics={extraRegions[editRegionIdx].lyrics ?? song.generationParams?.lyrics ?? song.lyrics ?? ''}
                  onCancel={() => setEditRegionIdx(null)}
                  onSubmit={(prompt, lyrics) => {
                    // Save this region's own prompt/lyrics; regeneration happens with the global button
                    setExtraRegions(prev => prev.map((r, j) => j === editRegionIdx ? { ...r, prompt, lyrics } : r));
                    setEditRegionIdx(null);
                  }}
                />
              )}
            </div>
          )}

          {/* Stem extraction progress */}
          {isProcessingStem && stemProcessing && (
            <div className="mt-2 p-2.5 rounded-lg bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2 mb-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-500 shrink-0" />
                <span className="text-xs font-medium text-purple-600 dark:text-purple-300 flex-1 truncate">
                  Extrayendo stems...
                </span>
                <span className="text-xs font-bold text-purple-500 tabular-nums">
                  {stemProcessing.progress}%
                </span>
              </div>
              <div className="relative h-1.5 bg-surface-300 rounded-full overflow-hidden mb-2">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-300"
                  style={{ width: `${stemProcessing.progress}%` }}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onMenuAction?.('extractStems'); }}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-600 dark:text-purple-300 text-[10px] font-medium transition-colors border border-purple-500/30"
                  title="Ver proceso en modal"
                >
                  <ExternalLink className="w-3 h-3" />
                  Ver proceso
                </button>
                {stemProcessing.progress >= 95 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onMenuAction?.('viewStems'); }}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-green-500/20 hover:bg-green-500/30 text-green-600 dark:text-green-300 text-[10px] font-medium transition-colors border border-green-500/30"
                    title="Ver stems completos"
                  >
                    <Scissors className="w-3 h-3" />
                    Ver stems
                  </button>
                )}
              </div>
              <p className="text-[9px] text-surface-500 mt-1.5">
                {stemProcessing.backend} · {stemProcessing.quality}
                {stemProcessing.regionStart !== undefined && ` · ${stemProcessing.regionEnd! - stemProcessing.regionStart!}s`}
              </p>
            </div>
          )}

          {song.isGenerating && (() => {
            const stageText =
              song.stage === 'Generating audio…' ? t('create.stageGenerating', 'Generando audio…')
              : (song.stage === 'Preparing model & LoRA...' || song.stage === 'Preparing model & LoRA…') ? t('create.stagePreparing', 'Preparando modelo y LoRA…')
              : (song.stage || t('create.generatingSong', 'Generando canción…'));
            const pct = typeof song.progress === 'number' ? song.progress : undefined;
            return (
              <div className="mt-1 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-accent-400 font-medium truncate">{stageText}</span>
                  {pct !== undefined && <span className="text-accent-400/70 font-mono tabular-nums shrink-0">{pct}%</span>}
                </div>
                <div className="relative h-1.5 bg-surface-300/60 rounded-full overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent-500 to-brand-500 transition-all duration-500 ease-out"
                    style={{ width: `${pct ?? 8}%` }}
                  />
                  {pct === undefined && (
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-accent-500/40 to-brand-500/40" />
                  )}
                </div>
              </div>
            );
          })()}

          {/* Row 4: Action buttons */}
          <div className="flex items-center gap-1 pt-0.5">
            {/* Like */}
            <button
              onClick={(e) => { e.stopPropagation(); onLike?.(); }}
              className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs transition-colors ${
                song.liked
                  ? 'bg-accent-500/20 text-accent-400'
                  : 'text-surface-500 hover:text-surface-800 hover:bg-surface-200'
              }`}
            >
              <ThumbsUp className={`w-3.5 h-3.5 ${song.liked ? 'fill-accent-400' : ''}`} />
              {song.likeCount ? <span>{song.likeCount}</span> : null}
            </button>
            {/* Dislike */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Set as disliked: if already liked, toggle back; otherwise mark as not-liked
                onLike?.();
              }}
              className="p-1 rounded-full text-surface-500 hover:text-surface-800 hover:bg-surface-200 transition-colors"
              title={t('common.dislike', 'Dislike')}
            >
              <ThumbsDown className="w-3.5 h-3.5" />
            </button>
            {/* Share */}
            <button
              onClick={(e) => { e.stopPropagation(); onMenuAction?.('share'); }}
              className="p-1 rounded-full text-surface-500 hover:text-surface-800 hover:bg-surface-200 transition-colors"
              title={t('common.share', 'Share')}
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
            {/* Video */}
            <button
              onClick={(e) => { e.stopPropagation(); onMenuAction?.('createVideo'); }}
              className="p-1 rounded-full text-surface-500 hover:text-surface-800 hover:bg-surface-200 transition-colors"
              title={t('common.createVideo', 'Create Video')}
            >
              <Video className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right: duration + ≡ + ··· */}
        <div className="flex flex-col items-end justify-between h-16 flex-shrink-0 gap-1">
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-xs text-surface-500 tabular-nums">
              {song.isGenerating ? '—' : (song.duration || '0:00')}
            </span>
            {song.createdAt && (() => {
              const d = new Date(song.createdAt);
              if (Number.isNaN(d.getTime())) return null;
              const pad = (n: number) => String(n).padStart(2, '0');
              const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
              const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
              return (
                <span
                  className="text-[10px] font-mono text-white/90 tabular-nums leading-none"
                  title={`Created: ${d.toLocaleString()}`}
                >
                  {dateStr} {timeStr}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => { e.stopPropagation(); onMenuAction?.('addToPlaylist'); }}
              className="p-1.5 rounded-lg text-surface-400 hover:text-surface-800 hover:bg-surface-200 transition-colors"
              title={t('common.addToWorkspace', 'Add to Workspace')}
            >
              <ListPlus className="w-4 h-4" />
            </button>
            <button
              onClick={handleMoreClick}
              className="p-1.5 rounded-lg text-surface-400 hover:text-surface-800 hover:bg-surface-200 transition-colors"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {menu && (
        <SongContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onAction={handleAction}
          hasAudioUrl={!!song.audioUrl}
        />
      )}
    </>
  );
})

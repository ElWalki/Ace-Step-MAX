import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, Maximize2, X } from 'lucide-react';

interface WaveformPlayerProps {
  src: string;
  title?: string;
  regionMode?: boolean;
  regionStart?: number;
  regionEnd?: number;
  onRegionChange?: (start: number, end: number) => void;
}

export default function WaveformPlayer({
  src, title, regionMode, regionStart = 0, regionEnd = 1, onRegionChange,
}: WaveformPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const animRef = useRef(0);
  const activeRef = useRef(false);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const modalContainerRef = useRef<HTMLDivElement>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable refs to avoid stale closures in the draw loop
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const regionStartRef = useRef(regionStart);
  regionStartRef.current = regionStart;
  const regionEndRef = useRef(regionEnd);
  regionEndRef.current = regionEnd;
  const regionModeRef = useRef(regionMode);
  regionModeRef.current = regionMode;
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;

  // Canvas dimensions — stored to avoid layout thrashing in draw
  const canvasSizeRef = useRef({ w: 0, h: 0 });
  const modalCanvasSizeRef = useRef({ w: 0, h: 0 });

  // Generic draw function that paints a waveform onto any container+canvas pair
  const drawOnCanvas = useCallback((
    container: HTMLDivElement | null,
    canvas: HTMLCanvasElement | null,
    sizeRef: React.MutableRefObject<{ w: number; h: number }>,
  ) => {
    const pk = peaksRef.current;
    if (!container || !canvas || !pk || pk.length === 0) return;
    const c = canvas.getContext('2d');
    if (!c) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === 0 || h === 0) return;

    // Re-sync canvas buffer when container size changes
    if (w !== sizeRef.current.w || h !== sizeRef.current.h) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      sizeRef.current = { w, h };
    }

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const prog = progressRef.current;
    const rStart = regionStartRef.current;
    const rEnd = regionEndRef.current;
    const rMode = regionModeRef.current;

    // NOTE: do NOT clamp to a 1px minimum here — that would draw all bars at a
    // fixed 1px pitch (total = pk.length px) instead of scaling to the real
    // container width, which pushes the painted progress ahead of the playhead
    // and hides the right side of the waveform when the panel is narrow.
    // Per-bar visibility is handled by the colW min below.
    const barW = w / pk.length;
    const midY = h / 2;
    const maxHalf = h * 0.48;
    const isLight = document.documentElement.classList.contains('light');

    // Region highlight background
    if (rMode) {
      c.fillStyle = isLight ? 'rgba(99,102,241,0.06)' : 'rgba(139,92,246,0.06)';
      c.fillRect(rStart * w, 0, (rEnd - rStart) * w, h);
    }

    // Center reference line
    c.fillStyle = isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.03)';
    c.fillRect(0, midY, w, 0.5);

    // Colors
    const playedColor = isLight ? 'rgba(99,102,241,0.8)' : 'rgba(139,92,246,0.85)';
    const regionActiveColor = isLight ? 'rgba(99,102,241,0.85)' : 'rgba(168,85,247,0.9)';
    const regionColor = isLight ? 'rgba(99,102,241,0.3)' : 'rgba(168,85,247,0.3)';
    const mutedColor = isLight ? 'rgba(99,102,241,0.25)' : 'rgba(139,92,246,0.35)';

    // Dense mirrored columns — raw WAV style
    for (let i = 0; i < pk.length; i++) {
      const x = Math.round(i * barW);
      const nextX = Math.round((i + 1) * barW);
      const colW = Math.max(1, nextX - x);
      const halfH = Math.max(0.5, pk[i] * maxHalf);
      const pct = (i + 0.5) / pk.length;

      if (rMode && pct >= rStart && pct <= rEnd) {
        c.fillStyle = pct <= prog ? regionActiveColor : regionColor;
      } else if (prog > 0 && pct <= prog) {
        c.fillStyle = playedColor;
      } else {
        c.fillStyle = mutedColor;
      }

      c.fillRect(x, midY - halfH, colW, halfH);
      c.fillRect(x, midY, colW, halfH);
    }

    // Playhead
    if (prog > 0) {
      const px = prog * w;
      c.fillStyle = isLight ? 'rgba(99,102,241,0.9)' : 'rgba(255,255,255,0.6)';
      c.fillRect(Math.round(px) - 0.5, 0, 1, h);
    }

    // Region handles
    if (rMode) {
      for (const pos of [rStart, rEnd]) {
        const x = pos * w;
        c.fillStyle = isLight ? 'rgba(99,102,241,0.85)' : 'rgba(168,85,247,0.85)';
        c.fillRect(x - 1, 0, 2, h);
        c.beginPath();
        c.arc(x, midY, 4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }, []);

  // Convenience: draw both inline and modal canvases
  const draw = useCallback(() => {
    drawOnCanvas(containerRef.current, canvasRef.current, canvasSizeRef);
    drawOnCanvas(modalContainerRef.current, modalCanvasRef.current, modalCanvasSizeRef);
  }, [drawOnCanvas]);

  // Decode audio to extract peaks
  useEffect(() => {
    if (!src) return;
    let cancelled = false;

    const decode = async () => {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buf = await response.arrayBuffer();
        // OfflineAudioContext avoids Chrome's autoplay policy that suspends
        // regular AudioContext created without a user gesture
        const oc = new OfflineAudioContext(1, 44100, 44100);
        const decoded = await oc.decodeAudioData(buf);
        if (cancelled) return;
        const raw = decoded.getChannelData(0);
        const bars = 500;
        const step = Math.max(1, Math.floor(raw.length / bars));
        const p: number[] = [];
        for (let i = 0; i < bars; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const v = Math.abs(raw[i * step + j] || 0);
            if (v > max) max = v;
          }
          p.push(max);
        }
        setPeaks(p);
      } catch {
        // Decode failed — show flat line fallback
        setPeaks(new Array(500).fill(0.05));
      }
    };

    decode();
    return () => { cancelled = true; };
  }, [src]);

  // rAF loop — separate from draw, guarded by activeRef
  useEffect(() => {
    if (!peaks || peaks.length === 0) return;
    activeRef.current = true;

    const loop = () => {
      if (!activeRef.current) return;
      const a = audioRef.current;
      if (a && !a.paused) {
        progressRef.current = a.currentTime / (a.duration || 1);
        setProgress(progressRef.current);
      }
      draw();
      animRef.current = requestAnimationFrame(loop);
    };

    // Initial draw + start loop
    draw();
    animRef.current = requestAnimationFrame(loop);

    return () => {
      activeRef.current = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [peaks, draw]);

  // ResizeObserver — force canvas buffer resync when container size changes
  // (e.g. when the user drags the panel divider or the window resizes)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      // Invalidate cached size so draw() re-creates the canvas buffer
      canvasSizeRef.current = { w: 0, h: 0 };
      draw();
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, [peaks, draw]);

  // Redraw on region changes (when not playing, loop may still be running)
  useEffect(() => { draw(); }, [regionStart, regionEnd, regionMode, draw]);

  // Modal canvas: observe size + initial draw
  useEffect(() => {
    if (!expanded) return;
    // Invalidate so first draw creates buffer at correct size
    modalCanvasSizeRef.current = { w: 0, h: 0 };
    // Small delay for DOM to mount
    const raf = requestAnimationFrame(() => draw());

    const container = modalContainerRef.current;
    if (!container) return () => cancelAnimationFrame(raf);

    const ro = new ResizeObserver(() => {
      modalCanvasSizeRef.current = { w: 0, h: 0 };
      draw();
    });
    ro.observe(container);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [expanded, draw]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setIsPlaying(true); }
    else { a.pause(); setIsPlaying(false); }
  }, []);

  // Seek on click (non-region mode) — works on both inline & modal canvas
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragging || regionMode) return;
    const parent = (e.target as HTMLElement).parentElement;
    const rect = parent?.getBoundingClientRect();
    const a = audioRef.current;
    if (!rect || !a) return;
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = pct * (a.duration || 0);
    setProgress(pct);
    progressRef.current = pct;
  }, [dragging, regionMode]);

  // Drag-to-seek for playback position (non-region mode)
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const parent = (e.target as HTMLElement).parentElement;
    if (regionMode) {
      // Region handle drag
      const rect = parent?.getBoundingClientRect();
      if (!rect) return;
      const pct = (e.clientX - rect.left) / rect.width;
      const ds = Math.abs(pct - regionStart);
      const de = Math.abs(pct - regionEnd);
      if (ds < 0.05 || de < 0.05) {
        e.preventDefault();
        setDragging(ds < de ? 'start' : 'end');
      }
      return;
    }
    // Non-region: drag-to-seek playback position
    const rect = parent?.getBoundingClientRect();
    const a = audioRef.current;
    if (!rect || !a || !a.duration) return;
    e.preventDefault();

    const seek = (clientX: number) => {
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      a.currentTime = pct * a.duration;
      setProgress(pct);
      progressRef.current = pct;
    };
    seek(e.clientX);

    const onMove = (ev: MouseEvent) => { seek(ev.clientX); };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [regionMode, regionStart, regionEnd]);

  // Region drag move/up
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const container = expanded ? modalContainerRef.current : containerRef.current;
      const rect = container?.getBoundingClientRect();
      if (!rect) return;
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (dragging === 'start') onRegionChange?.(Math.min(pct, regionEnd - 0.02), regionEnd);
      else onRegionChange?.(regionStart, Math.max(pct, regionStart + 0.02));
    };
    const up = () => setDragging(null);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  }, [dragging, regionStart, regionEnd, onRegionChange, expanded]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="space-y-0.5">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden"
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => { setIsPlaying(false); setProgress(0); progressRef.current = 0; }}
      />

      {/* Waveform — full-width with overlaid controls */}
      {peaks === null ? (
        <div className="w-full h-12 rounded-lg bg-surface-100 animate-pulse" />
      ) : (
        <div ref={containerRef}
          className={`w-full h-12 rounded-lg overflow-hidden relative group ${regionMode ? 'cursor-col-resize' : 'cursor-pointer'}`}>
          <canvas ref={canvasRef} onClick={handleClick} onMouseDown={handleMouseDown}
            className="absolute inset-0 w-full h-full"
          />
          {/* Overlay controls — visible on hover or when playing */}
          <div className={`absolute inset-0 flex items-center justify-between px-1 pointer-events-none transition-opacity ${isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <button onClick={e => { e.stopPropagation(); togglePlay(); }}
              className="pointer-events-auto p-1 rounded-full bg-black/40 hover:bg-black/60 text-white/90 transition-all backdrop-blur-sm">
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            </button>
            <button onClick={e => { e.stopPropagation(); setExpanded(true); }}
              className="pointer-events-auto p-1 rounded-full bg-black/40 hover:bg-black/60 text-white/90 transition-all backdrop-blur-sm"
              title="Expand waveform">
              <Maximize2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Info row */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] text-surface-500 truncate max-w-[60%]">{title || ''}</span>
        <span className="text-[10px] text-surface-400 tabular-nums">{fmt(progress * duration)} / {fmt(duration)}</span>
      </div>

      {/* Expanded modal */}
      {expanded && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setExpanded(false); }}>
          <div className="w-[90vw] max-w-3xl bg-surface-100 border border-surface-300 rounded-2xl shadow-2xl p-5 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-surface-700 truncate">{title || 'Waveform'}</span>
              <button onClick={() => setExpanded(false)}
                className="p-1 rounded-md hover:bg-surface-200 text-surface-400 hover:text-surface-700 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Large waveform */}
            <div ref={modalContainerRef}
              className={`w-full h-32 rounded-lg overflow-hidden relative ${regionMode ? 'cursor-col-resize' : 'cursor-pointer'}`}>
              <canvas ref={modalCanvasRef} onClick={handleClick} onMouseDown={handleMouseDown}
                className="absolute inset-0 w-full h-full"
              />
            </div>
            {/* Controls */}
            <div className="flex items-center gap-3">
              <button onClick={togglePlay}
                className="p-1.5 rounded-lg bg-accent-500/10 hover:bg-accent-500/20 text-accent-400 transition-colors">
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <span className="text-xs text-surface-500 tabular-nums">{fmt(progress * duration)} / {fmt(duration)}</span>
              {regionMode && (
                <span className="text-xs text-purple-400 ml-auto">
                  Region: {((regionStart) * 100).toFixed(0)}% – {((regionEnd) * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

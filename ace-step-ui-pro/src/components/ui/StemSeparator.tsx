import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Scissors, Download, Loader2, Music, Mic2, Drum, Guitar, Piano, Play, Pause, Volume2, VolumeX, DownloadCloud, ArrowLeft, AlertTriangle, CheckCircle2, PackagePlus, History, Clock, AlertCircle, Repeat } from 'lucide-react';
import type { Song } from '../../types';
import { generateApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useStemProcessing } from '../../hooks/useStemProcessing';

interface StemSeparatorProps {
  song: Song | null;
  onClose: () => void;
}

interface StemResult {
  name: string;
  url: string;
}

interface StemPlayerState {
  muted: boolean;
  solo: boolean;
  volume: number;
}

interface SeparatedSong {
  baseName: string;
  title: string | null;
  stems: StemResult[];
  stemCount: number;
  separatedAt: string;
}

const DEMUCS_MODELS = [
  { value: 'htdemucs_ft', label: 'HTDemucs Fine-Tuned', desc: 'Mejor calidad · 4 stems', stems: 4 },
  { value: 'htdemucs', label: 'HTDemucs', desc: 'Rápido · 4 stems', stems: 4 },
  { value: 'htdemucs_6s', label: 'HTDemucs 6-Stem', desc: 'Guitarra + Piano separados · 6 stems', stems: 6 },
];

const UVR_MODELS = [
  { value: 'UVR-MDX-NET-Inst_HQ_3.onnx', label: 'MDX-Net Inst HQ 3', desc: 'Mejor general' },
  { value: 'UVR-MDX-NET-Voc_FT.onnx', label: 'MDX-Net Vocal FT', desc: 'Enfocado en vocales' },
  { value: 'UVR_MDXNET_KARA_2.onnx', label: 'MDX-Net Karaoke 2', desc: 'Karaoke' },
  { value: 'Kim_Vocal_2.onnx', label: 'Kim Vocal 2', desc: 'Extracción vocal popular' },
  { value: 'UVR-MDX-NET-Inst_3.onnx', label: 'MDX-Net Inst 3', desc: 'Instrumental limpio' },
];

const ROFORMER_MODELS = [
  { value: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', label: 'BS-RoFormer SDR 12.97', desc: 'Mejor calidad', badge: 'BEST' },
  { value: 'model_bs_roformer_ep_368_sdr_12.9628.ckpt', label: 'BS-RoFormer SDR 12.96', desc: 'Alta calidad' },
  { value: 'model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt', label: 'Mel-Band RoFormer', desc: 'SDR 11.43' },
];

type Backend = 'demucs' | 'uvr' | 'roformer';

const QUALITIES = [
  { value: 'rapida', label: 'Rápida', desc: 'Procesado ligero — más rápido' },
  { value: 'alta', label: 'Alta', desc: 'Buen balance calidad/velocidad' },
  { value: 'maxima', label: 'Máxima', desc: 'Menos residuos — más lento' },
];

const STEM_ICONS_MAP: Record<string, React.FC<{ className?: string }>> = {
  vocals: Mic2,
  drums: Drum,
  bass: Guitar,
  other: Music,
  guitar: Guitar,
  piano: Piano,
  instrumental: Music,
};

const STEM_COLORS: Record<string, { text: string; bg: string; border: string; bar: string }> = {
  vocals:       { text: 'text-pink-400',    bg: 'bg-pink-500/10',    border: 'border-pink-500/20',    bar: 'bg-pink-500' },
  drums:        { text: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/20',  bar: 'bg-orange-500' },
  bass:         { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', bar: 'bg-emerald-500' },
  other:        { text: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    bar: 'bg-blue-500' },
  guitar:       { text: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   bar: 'bg-amber-500' },
  piano:        { text: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/20',  bar: 'bg-violet-500' },
  instrumental: { text: 'text-cyan-400',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/20',    bar: 'bg-cyan-500' },
};

const DEFAULT_COLOR = STEM_COLORS.other;

function parseStemsFromResponse(allStems: any): StemResult[] {
  if (Array.isArray(allStems)) {
    return allStems.map((s: any) => ({
      name: s.name || s.stem || 'unknown',
      url: s.url || s.path || '',
    }));
  }
  if (allStems && typeof allStems === 'object') {
    return Object.entries(allStems).map(([name, data]: [string, any]) => ({
      name,
      url: data.url || data.path || '',
    }));
  }
  return [];
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function StemSeparator({ song, onClose }: StemSeparatorProps) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [backend, setBackend] = useState<Backend>('demucs');
  const [model, setModel] = useState('htdemucs_ft');
  const [quality, setQuality] = useState('alta');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stems, setStems] = useState<StemResult[]>([]);
  const [error, setError] = useState('');

  // Dependency state
  const [deps, setDeps] = useState<{ demucs: boolean; audioSeparator: boolean } | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const backendPkg = backend === 'demucs' ? 'demucs' as const : 'audio-separator' as const;
  const backendReady = deps === null ? true : backend === 'demucs' ? deps.demucs : deps.audioSeparator;

  const currentModels = backend === 'demucs' ? DEMUCS_MODELS : backend === 'uvr' ? UVR_MODELS : ROFORMER_MODELS;

  // Reset model when backend changes
  useEffect(() => {
    if (backend === 'demucs') setModel('htdemucs_ft');
    else if (backend === 'uvr') setModel('UVR-MDX-NET-Inst_HQ_3.onnx');
    else setModel('model_bs_roformer_ep_317_sdr_12.9755.ckpt');
  }, [backend]);

  // Check separator dependencies on mount
  useEffect(() => {
    if (!song) return;
    setDepsLoading(true);
    setInstallError(null);
    generateApi.separatorDeps(token || '')
      .then(d => setDeps(d))
      .catch(() => setDeps(null))
      .finally(() => setDepsLoading(false));
  }, [song, token]);

  const handleInstallDep = async (pkg: 'demucs' | 'audio-separator') => {
    setInstalling(pkg);
    setInstallError(null);
    try {
      const result = await generateApi.installSeparatorDep(pkg, token || '');
      if (result.success) {
        const d = await generateApi.separatorDeps(token || '');
        setDeps(d);
      } else {
        setInstallError(result.error || 'Install failed');
      }
    } catch (err: any) {
      setInstallError(err?.message || 'Install failed');
    } finally {
      setInstalling(null);
    }
  };

  // Multi-track player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerStates, setPlayerStates] = useState<Record<string, StemPlayerState>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement>>({});
  const seekBarRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);

  // History state
  const [history, setHistory] = useState<SeparatedSong[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTitle, setHistoryTitle] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Region selection for sample extraction
  const [useRegion, setUseRegion] = useState(false);
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(2);
  const [previewAudioDuration, setPreviewAudioDuration] = useState(0);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const regionCanvasRef = useRef<HTMLCanvasElement>(null);
  const regionContainerRef = useRef<HTMLDivElement>(null);
  const [isDraggingStart, setIsDraggingStart] = useState(false);
  const [isDraggingEnd, setIsDraggingEnd] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [isLoadingWaveform, setIsLoadingWaveform] = useState(false);

  // Processing hook
  const { processing: globalProcessing, startProcessing, completeProcessing } = useStemProcessing();

  // Fetch history on mount
  useEffect(() => {
    if (!song || !token) return;
    setHistoryLoading(true);
    generateApi.listSeparatedSongs(token)
      .then(data => setHistory(data.songs || []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [song, token]);

  const handleLoadHistory = useCallback((item: SeparatedSong) => {
    Object.values(audioRefs.current).forEach(a => { a.pause(); a.src = ''; });
    audioRefs.current = {};
    cancelAnimationFrame(animFrameRef.current);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError('');
    setStems(item.stems);
    setHistoryTitle(item.title || item.baseName.slice(0, 12));
  }, []);

  // Initialize player states when stems arrive
  useEffect(() => {
    if (stems.length > 0) {
      const initial: Record<string, StemPlayerState> = {};
      stems.forEach(s => { initial[s.name] = { muted: false, solo: false, volume: 1 }; });
      setPlayerStates(initial);
    }
    return () => { cancelAnimationFrame(animFrameRef.current); };
  }, [stems]);

  // Sync mute/solo/volume to audio elements
  useEffect(() => {
    const hasSolo = Object.values(playerStates).some(s => s.solo);
    for (const stem of stems) {
      const audio = audioRefs.current[stem.name];
      if (!audio) continue;
      const state = playerStates[stem.name];
      if (!state) continue;
      if (hasSolo) {
        audio.muted = !state.solo;
      } else {
        audio.muted = state.muted;
      }
      audio.volume = state.volume;
    }
  }, [playerStates, stems]);

  const updateTime = useCallback(() => {
    const first = Object.values(audioRefs.current)[0];
    if (first) {
      setCurrentTime(first.currentTime);
      if (first.duration && isFinite(first.duration)) setDuration(first.duration);
    }
    // Region loop logic for preview audio
    if (useRegion && previewAudioRef.current && isPlaying) {
      const audio = previewAudioRef.current;
      if (audio.currentTime >= regionEnd) {
        audio.currentTime = regionStart;
      }
    }
    animFrameRef.current = requestAnimationFrame(updateTime);
  }, [useRegion, regionStart, regionEnd, isPlaying]);

  const handlePlayPause = useCallback(() => {
    // Region preview mode (before separation)
    if (useRegion && stems.length === 0 && previewAudioRef.current) {
      const audio = previewAudioRef.current;
      if (isPlaying) {
        audio.pause();
        cancelAnimationFrame(animFrameRef.current);
        setIsPlaying(false);
      } else {
        // Start from region start
        audio.currentTime = regionStart;
        audio.play();
        animFrameRef.current = requestAnimationFrame(updateTime);
        setIsPlaying(true);
      }
      return;
    }

    // Normal stem playback
    const audios = Object.values(audioRefs.current);
    if (audios.length === 0) return;
    if (isPlaying) {
      audios.forEach(a => a.pause());
      if (previewAudioRef.current) previewAudioRef.current.pause();
      cancelAnimationFrame(animFrameRef.current);
      setIsPlaying(false);
    } else {
      // Sync all to the same time before playing
      const time = audios[0]?.currentTime || 0;
      audios.forEach(a => { a.currentTime = time; a.play(); });
      animFrameRef.current = requestAnimationFrame(updateTime);
      setIsPlaying(true);
    }
  }, [isPlaying, updateTime, useRegion, stems.length, regionStart]);

  const seekFromMouseEvent = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!seekBarRef.current || !duration) return;
    const rect = seekBarRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = ratio * duration;
    Object.values(audioRefs.current).forEach(a => { a.currentTime = newTime; });
    setCurrentTime(newTime);
  }, [duration]);

  const seekFnRef = useRef(seekFromMouseEvent);
  seekFnRef.current = seekFromMouseEvent;

  const handleSeekMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    seekFnRef.current(e);
    const onMove = (ev: MouseEvent) => seekFnRef.current(ev);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const toggleMute = useCallback((name: string) => {
    setPlayerStates(prev => ({ ...prev, [name]: { ...prev[name], muted: !prev[name].muted, solo: false } }));
  }, []);

  const toggleSolo = useCallback((name: string) => {
    setPlayerStates(prev => {
      const wasSolo = prev[name].solo;
      const next = { ...prev };
      // Turn off all solos, then toggle this one
      for (const k of Object.keys(next)) { next[k] = { ...next[k], solo: false }; }
      if (!wasSolo) next[name] = { ...next[name], solo: true, muted: false };
      return next;
    });
  }, []);

  const setVolume = useCallback((name: string, volume: number) => {
    setPlayerStates(prev => ({ ...prev, [name]: { ...prev[name], volume } }));
  }, []);

  const handleSeparate = useCallback(async () => {
    if (!song?.audioUrl || !token) return;
    setProcessing(true);
    setProgress(10);
    setError('');
    setStems([]);
    setIsPlaying(false);
    // Clean up previous audio elements
    Object.values(audioRefs.current).forEach(a => { a.pause(); a.src = ''; });
    audioRefs.current = {};

    // Register processing in global state
    startProcessing({
      songId: song.id || song.audioUrl,
      songTitle: song.title || 'Untitled',
      audioUrl: song.audioUrl,
      backend,
      model,
      quality,
      ...(useRegion ? { regionStart, regionEnd } : {}),
    });

    const progressInterval = setInterval(() => {
      setProgress(p => Math.min(p + 5, 90));
    }, 2000);

    try {
      const stemCount = backend === 'roformer' ? 2 : backend === 'demucs' ? (DEMUCS_MODELS.find(m => m.value === model)?.stems ?? 4) : 2;
      const res = await generateApi.separateStems({
        audioUrl: song.audioUrl,
        backend,
        model,
        quality: backend === 'demucs' ? quality : 'alta',
        stems: stemCount,
        ...(useRegion ? { regionStart, regionEnd } : {}),
      }, token);

      clearInterval(progressInterval);
      setProgress(100);

      if (res.success && res.allStems) {
        const parsed = parseStemsFromResponse(res.allStems);
        setStems(parsed);
        // Complete processing
        completeProcessing();
        // Refresh history
        generateApi.listSeparatedSongs(token || '').then(data => setHistory(data.songs || [])).catch(() => {});
      }
    } catch (e: any) {
      clearInterval(progressInterval);
      setError(e.message || t('common.error'));
      completeProcessing();
    } finally {
      setProcessing(false);
    }
  }, [song, token, model, quality, backend, useRegion, regionStart, regionEnd, startProcessing, completeProcessing, t]);

  const handleDownloadStem = useCallback((stem: StemResult) => {
    const a = document.createElement('a');
    a.href = stem.url;
    a.download = `${historyTitle || song?.title || 'song'}_${stem.name}.wav`;
    a.click();
  }, [song, historyTitle]);

  const handleDownloadAll = useCallback(() => {
    stems.forEach((stem, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = stem.url;
        a.download = `${historyTitle || song?.title || 'song'}_${stem.name}.wav`;
        a.click();
      }, i * 300);
    });
  }, [stems, song, historyTitle]);

  const handleNewSeparation = useCallback(() => {
    Object.values(audioRefs.current).forEach(a => { a.pause(); a.src = ''; });
    audioRefs.current = {};
    cancelAnimationFrame(animFrameRef.current);
    setStems([]);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError('');
    setHistoryTitle(null);
  }, []);

  // Draw waveform on canvas
  const drawWaveform = useCallback(() => {
    const canvas = regionCanvasRef.current;
    const audio = previewAudioRef.current;
    if (!canvas || !audio || !useRegion || !previewAudioDuration) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (!w || !h) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const isLight = document.documentElement.classList.contains('light');
    const bgColor = isLight ? 'rgba(248,250,252,1)' : 'rgba(30,30,40,1)';
    const waveColor = isLight ? 'rgba(139,92,246,0.3)' : 'rgba(139,92,246,0.4)';
    const regionColor = isLight ? 'rgba(139,92,246,0.15)' : 'rgba(139,92,246,0.2)';
    const handleColor = isLight ? 'rgba(139,92,246,0.8)' : 'rgba(168,85,247,0.9)';

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    const midY = h / 2;
    const maxHeight = h * 0.4;

    // Draw waveform from real audio buffer if available
    if (audioBuffer) {
      const channelData = audioBuffer.getChannelData(0); // Use first channel (mono or left channel)
      const samplesPerPixel = Math.floor(channelData.length / w);
      
      for (let x = 0; x < w; x++) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.floor(start + samplesPerPixel);
        
        // Calculate RMS (root mean square) for this pixel
        let sum = 0;
        for (let i = start; i < end && i < channelData.length; i++) {
          sum += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sum / (end - start));
        const height = Math.min(maxHeight, rms * maxHeight * 3); // Scale for visibility
        
        const time = (x / w) * previewAudioDuration;
        const inRegion = time >= regionStart && time <= regionEnd;

        ctx.fillStyle = inRegion ? handleColor : waveColor;
        ctx.fillRect(x, midY - height, 1, height);
        ctx.fillRect(x, midY, 1, height);
      }
    } else {
      // Fallback: pseudo-random bars while loading
      const barCount = 100;
      const barWidth = w / barCount;

      for (let i = 0; i < barCount; i++) {
        const x = i * barWidth;
        const seed = (i * 1103515245 + 12345) >>> 0;
        const height = maxHeight * (0.3 + 0.7 * ((seed >> 16) & 0x7fff) / 0x7fff);
        
        const pct = i / barCount;
        const time = pct * previewAudioDuration;
        const inRegion = time >= regionStart && time <= regionEnd;

        ctx.fillStyle = inRegion ? handleColor : waveColor;
        ctx.fillRect(x, midY - height, Math.max(1, barWidth - 1), height);
        ctx.fillRect(x, midY, Math.max(1, barWidth - 1), height);
      }
    }

    // Region overlay
    const startX = (regionStart / previewAudioDuration) * w;
    const endX = (regionEnd / previewAudioDuration) * w;
    ctx.fillStyle = regionColor;
    ctx.fillRect(startX, 0, endX - startX, h);

    // Handles
    const handleWidth = 3;
    ctx.fillStyle = handleColor;
    ctx.fillRect(startX - handleWidth / 2, 0, handleWidth, h);
    ctx.fillRect(endX - handleWidth / 2, 0, handleWidth, h);

    // Time labels
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)';
    ctx.font = '10px monospace';
    ctx.fillText(`${regionStart.toFixed(1)}s`, startX + 5, 15);
    ctx.fillText(`${regionEnd.toFixed(1)}s`, endX - 40, 15);

    // Current time indicator
    if (isPlaying && audio.currentTime >= regionStart && audio.currentTime <= regionEnd) {
      const currentX = (audio.currentTime / previewAudioDuration) * w;
      ctx.strokeStyle = isLight ? 'rgba(99,102,241,0.9)' : 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(currentX, 0);
      ctx.lineTo(currentX, h);
      ctx.stroke();
    }
  }, [useRegion, previewAudioDuration, regionStart, regionEnd, isPlaying, audioBuffer]);

  // Update waveform when preview audio is loaded
  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!audio || !song?.audioUrl) return;

    const onLoadedMetadata = () => {
      const dur = audio.duration;
      if (dur && isFinite(dur)) {
        setPreviewAudioDuration(dur);
        // Initialize regionEnd if needed
        if (regionEnd === 2 && dur > 2) {
          setRegionEnd(Math.min(30, dur));
        }
      }
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => audio.removeEventListener('loadedmetadata', onLoadedMetadata);
  }, [song?.audioUrl, regionEnd]);

  // Decode audio for real waveform when region mode is activated
  useEffect(() => {
    if (!useRegion || !song?.audioUrl || audioBuffer) return;

    setIsLoadingWaveform(true);
    
    const decodeAudio = async () => {
      try {
        if (!song.audioUrl) return; // Type guard
        
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const response = await fetch(song.audioUrl);
        const arrayBuffer = await response.arrayBuffer();
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        setAudioBuffer(decodedBuffer);
        await audioContext.close();
      } catch (error) {
        console.error('Error decoding audio:', error);
      } finally {
        setIsLoadingWaveform(false);
      }
    };

    decodeAudio();
  }, [useRegion, song?.audioUrl, audioBuffer]);

  // Redraw waveform when needed
  useEffect(() => {
    if (!useRegion) return;
    drawWaveform();
    
    // Animation loop for playhead
    let rafId: number;
    const loop = () => {
      drawWaveform();
      rafId = requestAnimationFrame(loop);
    };
    if (isPlaying) {
      rafId = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(rafId);
  }, [useRegion, drawWaveform, isPlaying]);

  // Handle region dragging
  const handleRegionMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!regionContainerRef.current || !previewAudioDuration) return;
    e.preventDefault();

    const rect = regionContainerRef.current.getBoundingClientRect();
    const startX = (regionStart / previewAudioDuration) * rect.width;
    const endX = (regionEnd / previewAudioDuration) * rect.width;
    const clickX = e.clientX - rect.left;

    const HANDLE_TOLERANCE = 10;

    // Check if clicking near start handle
    if (Math.abs(clickX - startX) < HANDLE_TOLERANCE) {
      setIsDraggingStart(true);
      return;
    }

    // Check if clicking near end handle
    if (Math.abs(clickX - endX) < HANDLE_TOLERANCE) {
      setIsDraggingEnd(true);
      return;
    }

    // Click in the middle — seek to that position
    const clickTime = Math.max(0, Math.min(previewAudioDuration, (clickX / rect.width) * previewAudioDuration));
    if (previewAudioRef.current) {
      previewAudioRef.current.currentTime = clickTime;
      // Start playing if not already
      if (!isPlaying) {
        handlePlayPause();
      }
    }
  }, [previewAudioDuration, regionStart, regionEnd, isPlaying, handlePlayPause]);

  // Handle mouse move for dragging
  useEffect(() => {
    if (!isDraggingStart && !isDraggingEnd) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!regionContainerRef.current || !previewAudioDuration) return;
      const rect = regionContainerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const newTime = Math.max(0, Math.min(previewAudioDuration, (clickX / rect.width) * previewAudioDuration));

      if (isDraggingStart) {
        // Ensure minimum 2 seconds
        const maxStart = regionEnd - 2;
        setRegionStart(Math.max(0, Math.min(maxStart, newTime)));
      } else if (isDraggingEnd) {
        // Ensure minimum 2 seconds
        const minEnd = regionStart + 2;
        setRegionEnd(Math.max(minEnd, Math.min(previewAudioDuration, newTime)));
      }
    };

    const onMouseUp = () => {
      setIsDraggingStart(false);
      setIsDraggingEnd(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDraggingStart, isDraggingEnd, previewAudioDuration, regionStart, regionEnd]);

  // Validate region inputs
  const handleRegionStartChange = useCallback((value: number) => {
    const maxStart = regionEnd - 2;
    setRegionStart(Math.max(0, Math.min(maxStart, value)));
  }, [regionEnd]);

  const handleRegionEndChange = useCallback((value: number) => {
    const minEnd = regionStart + 2;
    setRegionEnd(Math.max(minEnd, Math.min(previewAudioDuration || 9999, value)));
  }, [regionStart, previewAudioDuration]);

  // When an audio ends, stop playback
  const handleAudioEnded = useCallback(() => {
    setIsPlaying(false);
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  if (!song) return null;

  const hasSolo = Object.values(playerStates).some(s => s.solo);
  const displayTitle = historyTitle || song.title || 'Untitled';
  const hasHistory = history.length > 0;
  const historyVisible = showHistory && hasHistory;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={`bg-surface-50 border border-surface-300 rounded-2xl max-h-[85vh] flex flex-row animate-scale-in shadow-2xl relative
        ${historyVisible ? (stems.length > 0 ? 'w-[750px]' : 'w-[640px]') : (stems.length > 0 ? 'w-[560px]' : 'w-[440px]')}`}>

        {/* === History Sidebar === */}
        {historyVisible && (
          <div className="w-[200px] border-r border-surface-200 flex flex-col rounded-l-2xl overflow-hidden shrink-0">
            <div className="px-3 py-3 border-b border-surface-200 bg-surface-100/50">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-surface-500 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                Historial
              </h4>
            </div>
            <div className="flex-1 overflow-y-auto">
              {historyLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-surface-400" />
                </div>
              ) : (
                <>
                  {/* Active processing indicator */}
                  {globalProcessing && (
                    <div className="px-3 py-3 border-b border-accent-200 bg-gradient-to-br from-accent-500/10 to-brand-500/10">
                      <div className="flex items-start gap-2 mb-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-500 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-accent-600 dark:text-accent-400 truncate">
                            {globalProcessing.songTitle}
                          </p>
                          <p className="text-[10px] text-surface-500 mt-0.5">
                            {globalProcessing.backend} · {globalProcessing.quality}
                          </p>
                        </div>
                      </div>
                      {/* Progress bar */}
                      <div className="relative h-1.5 bg-surface-300 rounded-full overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent-500 to-brand-500 transition-all duration-300"
                          style={{ width: `${globalProcessing.progress}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-center text-surface-500 mt-1">
                        {globalProcessing.progress}%
                      </p>
                    </div>
                  )}
                  
                  {/* History items */}
                  {history.map(item => {
                    const label = item.title || item.baseName.slice(0, 12) + '…';
                    const isActive = historyTitle === label && stems.length > 0;
                    return (
                      <button
                        key={item.baseName}
                        onClick={() => handleLoadHistory(item)}
                        className={`w-full text-left px-3 py-2.5 border-b border-surface-100 hover:bg-surface-100 transition-colors group
                          ${isActive ? 'bg-accent-500/10 border-l-2 !border-l-accent-500' : ''}`}
                      >
                        <p className="text-xs font-medium text-surface-800 truncate group-hover:text-accent-500 transition-colors">
                          {item.title || item.baseName.slice(0, 12) + '…'}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-surface-400">{item.stemCount} stems</span>
                          <span className="text-[10px] text-surface-400 flex items-center gap-0.5">
                            <Clock className="w-2.5 h-2.5" />
                            {new Date(item.separatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        )}

        {/* === Main Content === */}
        <div className={`flex-1 flex flex-col min-w-0 ${historyVisible ? 'rounded-r-2xl' : 'rounded-2xl'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <h3 className="text-sm font-semibold text-surface-900 flex items-center gap-2">
            <Scissors className="w-4 h-4 text-accent-400" />
            {t('stems.title', 'Stem Separation')}
          </h3>
          <div className="flex items-center gap-2">
            {hasHistory && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`p-1.5 rounded-lg transition-all ${
                  showHistory
                    ? 'bg-accent-500/10 text-accent-500 hover:bg-accent-500/20'
                    : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
                }`}
                title={showHistory ? 'Ocultar historial' : 'Mostrar historial'}
              >
                <History className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={onClose} className="text-surface-400 hover:text-surface-700 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${globalProcessing ? 'pb-20' : ''}`}>
          {/* Song info */}
          <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-100 border border-surface-200">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-500/20 to-brand-500/20 flex items-center justify-center">
              <Music className="w-5 h-5 text-surface-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-surface-900 truncate">{displayTitle}</p>
              <p className="text-xs text-surface-500">{song.duration || '—'}</p>
            </div>
          </div>

          {/* Engine / Model / Quality selectors — hide after separation */}
          {stems.length === 0 && (
            <div className="space-y-3">
              {/* Backend selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-surface-600">{t('stems.backend', 'Separation Engine')}</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => !processing && setBackend('demucs')}
                    disabled={processing}
                    className={`flex flex-col items-center px-2 py-2.5 rounded-lg border text-xs transition-all disabled:opacity-50
                      ${backend === 'demucs'
                        ? 'border-accent-500 bg-accent-500/10 text-accent-400 font-semibold'
                        : 'border-surface-300 bg-surface-100 text-surface-500 hover:border-surface-400'}`}
                  >
                    <span className="font-semibold">Demucs</span>
                    <span className="text-[9px] opacity-70 mt-0.5">2/4 stems</span>
                  </button>
                  <button
                    onClick={() => !processing && setBackend('roformer')}
                    disabled={processing}
                    className={`flex flex-col items-center px-2 py-2.5 rounded-lg border text-xs transition-all disabled:opacity-50 relative
                      ${backend === 'roformer'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 font-semibold'
                        : 'border-surface-300 bg-surface-100 text-surface-500 hover:border-surface-400'}`}
                  >
                    <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 text-[8px] font-bold bg-emerald-500 text-white rounded-full leading-none">BEST</span>
                    <span className="font-semibold">RoFormer</span>
                    <span className="text-[9px] opacity-70 mt-0.5">SDR 12.97</span>
                  </button>
                  <button
                    onClick={() => !processing && setBackend('uvr')}
                    disabled={processing}
                    className={`flex flex-col items-center px-2 py-2.5 rounded-lg border text-xs transition-all disabled:opacity-50
                      ${backend === 'uvr'
                        ? 'border-accent-500 bg-accent-500/10 text-accent-400 font-semibold'
                        : 'border-surface-300 bg-surface-100 text-surface-500 hover:border-surface-400'}`}
                  >
                    <span className="font-semibold">UVR</span>
                    <span className="text-[9px] opacity-70 mt-0.5">MDX-Net</span>
                  </button>
                </div>
              </div>

              {/* Dependency status */}
              {depsLoading && (
                <div className="flex items-center gap-2 px-3 py-2 bg-surface-200 border border-surface-300 rounded-lg">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-surface-500" />
                  <span className="text-xs text-surface-500">Checking dependencies…</span>
                </div>
              )}
              {!depsLoading && deps && !backendReady && (
                <div className="px-3 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-600 dark:text-amber-300/90">
                      Package <strong>{backendPkg}</strong> is not installed.
                    </p>
                  </div>
                  {installError && <p className="text-xs text-red-400 pl-5">{installError}</p>}
                  <button
                    onClick={() => handleInstallDep(backendPkg)}
                    disabled={!!installing}
                    className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-xs font-medium text-amber-600 dark:text-amber-300 transition-colors disabled:opacity-50 w-full justify-center"
                  >
                    {installing === backendPkg ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Installing…</>
                    ) : (
                      <><PackagePlus className="w-3 h-3" /> Install {backendPkg}</>
                    )}
                  </button>
                </div>
              )}
              {!depsLoading && deps && backendReady && (
                <div className="flex items-center gap-2 px-3 py-1.5 text-emerald-500">
                  <CheckCircle2 className="w-3 h-3" />
                  <span className="text-[11px]">Dependencies ready</span>
                </div>
              )}

              {/* RoFormer download warning */}
              {backend === 'roformer' && (
                <div className="flex items-start gap-2 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                  <AlertTriangle className="w-3 h-3 text-blue-400 mt-0.5 shrink-0" />
                  <p className="text-[10px] text-blue-500 dark:text-blue-300/80">First run downloads the model (~1 GB). Subsequent runs use the cached model.</p>
                </div>
              )}

              {/* Model */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-surface-600">{t('stems.model', 'Separation Model')}</label>
                <select
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  disabled={processing}
                  className="w-full bg-surface-100 border border-surface-300 rounded-lg px-3 py-2 text-sm text-surface-900
                    focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50"
                >
                  {currentModels.map(m => (
                    <option key={m.value} value={m.value}>{m.label} — {m.desc}</option>
                  ))}
                </select>
              </div>

              {/* Quality — only for Demucs */}
              {backend === 'demucs' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-surface-600">{t('stems.quality', 'Processing Quality')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {QUALITIES.map(q => (
                      <button
                        key={q.value}
                        onClick={() => setQuality(q.value)}
                        disabled={processing}
                        className={`flex flex-col items-center px-2 py-2 rounded-lg border text-xs transition-all disabled:opacity-50
                          ${quality === q.value
                            ? 'border-accent-500 bg-accent-500/10 text-accent-400 font-semibold'
                            : 'border-surface-300 bg-surface-100 text-surface-500 hover:border-surface-400'}`}
                      >
                        <span>{q.label}</span>
                        <span className="text-[10px] opacity-70 mt-0.5">{q.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Region selection for sample extraction */}
              <div className="space-y-2 p-3 rounded-xl bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="use-region"
                    checked={useRegion}
                    onChange={e => setUseRegion(e.target.checked)}
                    disabled={processing}
                    className="w-3.5 h-3.5 rounded accent-purple-500"
                  />
                  <label htmlFor="use-region" className="text-xs font-medium text-purple-600 dark:text-purple-300 flex items-center gap-1.5 cursor-pointer">
                    <Scissors className="w-3 h-3" />
                    Extraer región específica (samples)
                  </label>
                </div>
                
                {useRegion && (
                  <>
                    {/* Visual waveform region selector */}
                    <div ref={regionContainerRef} className="relative mt-3 rounded-lg overflow-hidden border border-purple-500/30 bg-surface-50">
                      <canvas
                        ref={regionCanvasRef}
                        onMouseDown={handleRegionMouseDown}
                        className="w-full h-20 cursor-crosshair"
                        style={{ display: 'block' }}
                      />
                      
                      {/* Loading overlay */}
                      {isLoadingWaveform && (
                        <div className="absolute inset-0 bg-surface-50/80 backdrop-blur-sm flex items-center justify-center">
                          <div className="flex items-center gap-2 text-purple-600 dark:text-purple-300">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-xs font-medium">Cargando waveform...</span>
                          </div>
                        </div>
                      )}
                      
                      <div className="absolute top-1 right-1 flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handlePlayPause(); }}
                          disabled={processing || isLoadingWaveform}
                          className="p-1 rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-600 dark:text-purple-300 transition-colors disabled:opacity-50"
                          title={isPlaying ? 'Pausar preview' : 'Reproducir región'}
                        >
                          {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>

                    {/* Time inputs */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-surface-600 block mb-1">Inicio (seg)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={regionStart}
                          onChange={e => handleRegionStartChange(Number(e.target.value))}
                          disabled={processing}
                          className="w-full bg-surface-100 border border-surface-300 rounded-lg px-2 py-1.5 text-xs text-surface-900
                            focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-surface-600 block mb-1">Fin (seg)</label>
                        <input
                          type="number"
                          min={regionStart + 2}
                          step="0.1"
                          value={regionEnd}
                          onChange={e => handleRegionEndChange(Number(e.target.value))}
                          disabled={processing}
                          className="w-full bg-surface-100 border border-surface-300 rounded-lg px-2 py-1.5 text-xs text-surface-900
                            focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
                        />
                      </div>
                    </div>

                    <p className="text-[10px] text-surface-500">
                      Duración: {(regionEnd - regionStart).toFixed(1)}s · Click izquierdo para saltar · Arrastra bordes para ajustar
                    </p>
                  </>
                )}
                
                {!useRegion && (
                  <p className="text-[10px] text-surface-500 mt-1.5">
                    Activar para extraer stems de una sección específica (útil para samples). Mínimo 2 segundos.
                  </p>
                )}
              </div>

              {/* Hidden preview audio element */}
              {song?.audioUrl && (
                <audio
                  ref={previewAudioRef}
                  src={song.audioUrl}
                  preload="metadata"
                  style={{ display: 'none' }}
                />
              )}
            </div>
          )}

          {/* Separate button */}
          {stems.length === 0 && (
            <button
              onClick={handleSeparate}
              disabled={processing || !song.audioUrl || !backendReady}
              className="w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2
                bg-gradient-to-r from-accent-600 to-brand-600 text-white hover:from-accent-500 hover:to-brand-500
                shadow-lg shadow-accent-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {processing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('stems.processing', 'Separating...')} {progress}%
                </>
              ) : (
                <>
                  <Scissors className="w-4 h-4" />
                  {useRegion ? 'Extraer Región' : t('stems.separate', 'Separate Stems')}
                </>
              )}
            </button>
          )}

          {/* Progress bar */}
          {processing && (
            <div className="w-full h-1.5 rounded-full bg-surface-200 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent-500 to-brand-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">{error}</p>
          )}

          {/* ===== Multi-track Stem Player ===== */}
          {stems.length > 0 && (
            <div className="space-y-3">
              {/* Transport bar */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-100 border border-surface-200">
                <button
                  onClick={handlePlayPause}
                  className="w-10 h-10 rounded-xl bg-gradient-to-r from-accent-600 to-brand-600 text-white
                    flex items-center justify-center hover:from-accent-500 hover:to-brand-500 transition-all shadow-md shrink-0"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>
                <span className="text-xs font-mono text-surface-500 w-12 text-right tabular-nums select-none">{formatTime(currentTime)}</span>
                <div
                  ref={seekBarRef}
                  onMouseDown={handleSeekMouseDown}
                  className="flex-1 h-6 flex items-center cursor-pointer relative group select-none"
                >
                  <div className="absolute inset-x-0 h-1.5 rounded-full bg-surface-300" />
                  <div
                    className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-accent-500 to-brand-500 pointer-events-none"
                    style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
                  />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg shadow-black/20
                      border-2 border-accent-500 pointer-events-none transition-transform group-hover:scale-125"
                    style={{ left: duration ? `calc(${(currentTime / duration) * 100}% - 7px)` : '-7px' }}
                  />
                </div>
                <span className="text-xs font-mono text-surface-500 w-12 tabular-nums select-none">{formatTime(duration)}</span>
              </div>

              {/* Stem tracks */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                    {t('stems.results', 'Separated Stems')} ({stems.length})
                  </span>
                  <span className="text-[10px] text-surface-400">
                    {t('stems.clickSolo', 'Click name = Solo')}
                  </span>
                </div>
                {stems.map(stem => {
                  const colors = STEM_COLORS[stem.name] || DEFAULT_COLOR;
                  const Icon = STEM_ICONS_MAP[stem.name] || Music;
                  const state = playerStates[stem.name];
                  const isMuted = state ? (hasSolo ? !state.solo : state.muted) : false;

                  return (
                    <div
                      key={stem.name}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all
                        ${isMuted ? 'opacity-40 border-surface-300 bg-surface-100' : `${colors.bg} ${colors.border}`}`}
                    >
                      {/* Icon */}
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colors.bg} ${colors.text}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>

                      {/* Name (click = solo) */}
                      <button
                        onClick={() => toggleSolo(stem.name)}
                        className={`text-sm font-medium capitalize min-w-[80px] text-left transition-colors
                          ${state?.solo ? 'text-yellow-400' : colors.text}
                          hover:underline`}
                        title={state?.solo ? t('stems.unsolo', 'Unsolo') : t('stems.solo', 'Solo')}
                      >
                        {stem.name}
                        {state?.solo && <span className="ml-1 text-[9px] font-bold uppercase">S</span>}
                      </button>

                      {/* Volume slider */}
                      <input
                        type="range"
                        min="0" max="1" step="0.01"
                        value={state?.volume ?? 1}
                        onChange={e => setVolume(stem.name, parseFloat(e.target.value))}
                        className="flex-1 h-1 appearance-none bg-surface-300 rounded-full cursor-pointer
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
                      />

                      {/* Mute toggle */}
                      <button
                        onClick={() => toggleMute(stem.name)}
                        className={`p-1.5 rounded-lg transition-colors ${state?.muted ? 'text-red-400 bg-red-500/10' : 'text-surface-400 hover:text-surface-600 hover:bg-surface-200'}`}
                        title={state?.muted ? t('stems.unmute', 'Unmute') : t('stems.mute', 'Mute')}
                      >
                        {state?.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      </button>

                      {/* Download individual */}
                      <button
                        onClick={() => handleDownloadStem(stem)}
                        className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-200 transition-colors"
                        title={t('common.download', 'Download')}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>

                      {/* Hidden audio element */}
                      <audio
                        ref={el => { if (el) audioRefs.current[stem.name] = el; }}
                        src={stem.url}
                        preload="auto"
                        onEnded={handleAudioEnded}
                        onLoadedMetadata={e => {
                          const d = (e.target as HTMLAudioElement).duration;
                          if (d && isFinite(d) && d > duration) setDuration(d);
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Bottom actions */}
              <div className="flex gap-2">
                <button
                  onClick={handleDownloadAll}
                  className="flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5
                    bg-gradient-to-r from-accent-600 to-brand-600 text-white hover:from-accent-500 hover:to-brand-500
                    shadow-lg shadow-accent-500/25 transition-all"
                >
                  <DownloadCloud className="w-3.5 h-3.5" />
                  {t('stems.downloadAll', 'Download All Stems')}
                </button>
              </div>
              <button
                onClick={handleNewSeparation}
                className="w-full py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5
                  bg-surface-200 text-surface-600 hover:bg-surface-300 transition-colors"
                title={t('stems.reseparate', 'New separation')}
              >
                <Repeat className="w-3.5 h-3.5" />
                {t('stems.newSeparation', 'Volver a separar')}
              </button>
            </div>
          )}
        </div>

        {/* Global progress bar — always visible when processing */}
        {globalProcessing && (
          <div className="absolute bottom-0 left-0 right-0 bg-surface-50 border-t border-surface-200 px-4 py-3 rounded-b-2xl">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-accent-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-medium text-surface-700 truncate">
                    Separando: {globalProcessing.songTitle}
                  </p>
                  <span className="text-xs font-semibold text-accent-500 tabular-nums">
                    {globalProcessing.progress}%
                  </span>
                </div>
                <div className="relative h-2 bg-surface-300 rounded-full overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent-500 to-brand-500 transition-all duration-300"
                    style={{ width: `${globalProcessing.progress}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

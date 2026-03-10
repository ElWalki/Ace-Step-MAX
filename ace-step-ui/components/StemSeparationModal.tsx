import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X, Play, Download, Pause, Loader2, Music, Mic, Guitar, Drum, Volume2, AlertTriangle, CheckCircle2, PackagePlus } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useAuth } from '../context/AuthContext';
import { trainingApi } from '../services/api';
import { Song } from '../types';

// UVR models (must match separate_audio.py)
const UVR_MODELS = [
  { name: 'UVR-MDX-NET-Inst_HQ_3.onnx', description: 'MDX-Net Inst HQ 3 — best overall' },
  { name: 'UVR-MDX-NET-Voc_FT.onnx', description: 'MDX-Net Vocal FT — vocal-focused' },
  { name: 'UVR_MDXNET_KARA_2.onnx', description: 'MDX-Net Karaoke 2' },
  { name: 'Kim_Vocal_2.onnx', description: 'Kim Vocal 2 — popular vocal extraction' },
  { name: 'UVR-MDX-NET-Inst_3.onnx', description: 'MDX-Net Inst 3 — clean instrumental' },
];

// Demucs models (must match separate_audio.py)
const DEMUCS_MODELS = [
  { name: 'htdemucs_ft', description: 'HTDemucs Fine-Tuned — best quality', stems: 4 },
  { name: 'htdemucs', description: 'HTDemucs — fast', stems: 4 },
  { name: 'htdemucs_6s', description: 'HTDemucs 6-Stem — guitar & piano', stems: 6 },
];

// RoFormer models (must match separate_audio.py)
const ROFORMER_MODELS = [
  { name: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', description: 'BS-RoFormer SDR 12.97', badge: 'BEST' },
  { name: 'model_bs_roformer_ep_368_sdr_12.9628.ckpt', description: 'BS-RoFormer SDR 12.96' },
  { name: 'model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt', description: 'Mel-Band RoFormer SDR 11.43' },
];

interface StemSeparationModalProps {
  isOpen: boolean;
  onClose: () => void;
  song: Song;
}

type Backend = 'demucs' | 'uvr' | 'roformer';
type Quality = 'rapida' | 'alta' | 'maxima';
type StemCount = 2 | 4;

interface StemResult {
  url: string;
  path: string;
  filename: string;
}

const STEM_ICONS: Record<string, React.ReactNode> = {
  vocals: <Mic size={16} />,
  instrumental: <Guitar size={16} />,
  drums: <Drum size={16} />,
  bass: <Volume2 size={16} />,
  other: <Music size={16} />,
};

const STEM_COLORS: Record<string, string> = {
  vocals: 'text-pink-400',
  instrumental: 'text-blue-400',
  drums: 'text-orange-400',
  bass: 'text-green-400',
  other: 'text-purple-400',
};

export const StemSeparationModal: React.FC<StemSeparationModalProps> = ({ isOpen, onClose, song }) => {
  const { t } = useI18n();
  const { token } = useAuth();

  // Options
  const [backend, setBackend] = useState<Backend>('demucs');
  const [quality, setQuality] = useState<Quality>('alta');
  const [stems, setStems] = useState<StemCount>(2);
  const [uvrModel, setUvrModel] = useState(UVR_MODELS[0].name);
  const [roformerModel, setRoformerModel] = useState(ROFORMER_MODELS[0].name);
  const [demucsModel, setDemucsModel] = useState(DEMUCS_MODELS[0].name);

  // State
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, StemResult> | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [playingStem, setPlayingStem] = useState<string | null>(null);

  // Dependency status
  const [deps, setDeps] = useState<{ demucs: boolean; audioSeparator: boolean } | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // Audio refs for playback
  const audioRefs = useRef<Record<string, HTMLAudioElement>>({});

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setResults(null);
      setError(null);
      setElapsed(null);
      setPlayingStem(null);
      // Clean up any playing audio
      (Object.values(audioRefs.current) as HTMLAudioElement[]).forEach(a => { a.pause(); a.currentTime = 0; });
      audioRefs.current = {};
    }
  }, [isOpen]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      (Object.values(audioRefs.current) as HTMLAudioElement[]).forEach(a => { a.pause(); });
    };
  }, []);

  // Check separator dependencies when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setDepsLoading(true);
    setInstallError(null);
    trainingApi.separatorDeps(token || undefined)
      .then(d => setDeps(d))
      .catch(() => setDeps(null))
      .finally(() => setDepsLoading(false));
  }, [isOpen, token]);

  // Which package does the selected backend need?
  const backendPkg = backend === 'demucs' ? 'demucs' as const : 'audio-separator' as const;
  const backendReady = deps === null
    ? true // if check failed, don't block the user
    : backend === 'demucs' ? deps.demucs : deps.audioSeparator;

  const handleInstallDep = async (pkg: 'demucs' | 'audio-separator') => {
    setInstalling(pkg);
    setInstallError(null);
    try {
      const result = await trainingApi.installSeparatorDep(pkg, token || undefined);
      if (result.success) {
        // Refresh deps
        const d = await trainingApi.separatorDeps(token || undefined);
        setDeps(d);
      } else {
        setInstallError(result.error || t('stemInstallFailed'));
      }
    } catch (err: any) {
      setInstallError(err?.message || t('stemInstallFailed'));
    } finally {
      setInstalling(null);
    }
  };

  if (!isOpen) return null;

  const handleSeparate = async () => {
    if (!song.audioUrl) return;

    setProcessing(true);
    setError(null);
    setResults(null);
    setElapsed(null);
    setPlayingStem(null);

    try {
      const result = await trainingApi.separateStems(
        song.audioUrl,
        backend === 'demucs' ? quality : 'alta',
        token || undefined,
        {
          backend,
          model: backend === 'demucs' ? demucsModel : backend === 'uvr' ? uvrModel : backend === 'roformer' ? roformerModel : undefined,
          stems: backend === 'roformer' ? 2 : stems,
        }
      );

      if (result.success && result.allStems) {
        setResults(result.allStems);
        setElapsed(result.elapsed);
      } else {
        setError(result.error || t('stemSeparationFailed'));
      }
    } catch (err: any) {
      console.error('[StemSeparation] Error:', err);
      setError(err?.message || t('stemSeparationFailed'));
    } finally {
      setProcessing(false);
    }
  };

  const handlePlayStem = (stemName: string, url: string) => {
    // Stop currently playing
    if (playingStem) {
      const current = audioRefs.current[playingStem];
      if (current) {
        current.pause();
        current.currentTime = 0;
      }
    }

    if (playingStem === stemName) {
      setPlayingStem(null);
      return;
    }

    // Build full URL
    const baseUrl = window.location.port === '3000'
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : window.location.origin;
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

    if (!audioRefs.current[stemName]) {
      audioRefs.current[stemName] = new Audio(fullUrl);
      audioRefs.current[stemName].onended = () => setPlayingStem(null);
    }

    audioRefs.current[stemName].play();
    setPlayingStem(stemName);
  };

  const handleDownloadStem = async (url: string, filename: string) => {
    const baseUrl = window.location.port === '3000'
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : window.location.origin;
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

    try {
      const resp = await fetch(fullUrl);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('[StemSeparation] Download failed:', err);
    }
  };

  const handleDownloadAll = () => {
    if (!results) return;
    (Object.values(results) as StemResult[]).forEach(stem => {
      handleDownloadStem(stem.url, stem.filename);
    });
  };

  const qualityLabels: Record<Quality, string> = {
    rapida: t('stemQualityFast'),
    alta: t('stemQualityHigh'),
    maxima: t('stemQualityMax'),
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && !processing && onClose()}
    >
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-2xl w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex justify-between items-center px-5 py-4 border-b border-zinc-200 dark:border-white/10">
          <div>
            <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{t('extractStems')}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate max-w-[280px]">{song.title || 'Audio'}</p>
          </div>
          <button
            onClick={onClose}
            disabled={processing}
            className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 custom-scrollbar">
          {/* Backend selector */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              {t('stemBackend')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => !processing && setBackend('demucs')}
                disabled={processing}
                className={`px-2 py-2.5 rounded-xl text-sm font-medium transition-all border ${
                  backend === 'demucs'
                    ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-600 dark:text-indigo-400'
                    : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                } disabled:opacity-50`}
              >
                <div className="font-semibold text-xs">Demucs</div>
                <div className="text-[9px] opacity-70 mt-0.5">2/4 stems</div>
              </button>
              <button
                onClick={() => !processing && setBackend('roformer')}
                disabled={processing}
                className={`px-2 py-2.5 rounded-xl text-sm font-medium transition-all border relative ${
                  backend === 'roformer'
                    ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-600 dark:text-emerald-400'
                    : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                } disabled:opacity-50`}
              >
                <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 text-[8px] font-bold bg-emerald-500 text-white rounded-full leading-none">BEST</span>
                <div className="font-semibold text-xs">RoFormer</div>
                <div className="text-[9px] opacity-70 mt-0.5">SDR 12.97</div>
              </button>
              <button
                onClick={() => !processing && setBackend('uvr')}
                disabled={processing}
                className={`px-2 py-2.5 rounded-xl text-sm font-medium transition-all border ${
                  backend === 'uvr'
                    ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-600 dark:text-indigo-400'
                    : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                } disabled:opacity-50`}
              >
                <div className="font-semibold text-xs">UVR</div>
                <div className="text-[9px] opacity-70 mt-0.5">MDX-Net</div>
              </button>
            </div>
          </div>

          {/* Dependency status banner */}
          {depsLoading && (
            <div className="flex items-center gap-2 px-3 py-2 bg-zinc-500/10 border border-zinc-500/20 rounded-lg">
              <Loader2 size={14} className="animate-spin text-zinc-400" />
              <span className="text-xs text-zinc-400">{t('stemDepsChecking')}</span>
            </div>
          )}
          {!depsLoading && deps && !backendReady && (
            <div className="px-3 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-300/90">
                  {t('stemDepsMissing', { pkg: backendPkg })}
                </p>
              </div>
              {installError && (
                <p className="text-xs text-red-400 pl-5">{installError}</p>
              )}
              <button
                onClick={() => handleInstallDep(backendPkg)}
                disabled={!!installing}
                className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-xs font-medium text-amber-300 transition-colors disabled:opacity-50 w-full justify-center"
              >
                {installing === backendPkg ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    {t('stemDepsInstalling')}
                  </>
                ) : (
                  <>
                    <PackagePlus size={12} />
                    {t('stemDepsInstall', { pkg: backendPkg })}
                  </>
                )}
              </button>
            </div>
          )}
          {!depsLoading && deps && backendReady && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-emerald-400/80">
              <CheckCircle2 size={12} />
              <span className="text-[11px]">{t('stemDepsReady')}</span>
            </div>
          )}

          {/* Demucs options */}
          {backend === 'demucs' && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                  {t('stemModel')}
                </label>
                <select
                  value={demucsModel}
                  onChange={(e) => {
                    setDemucsModel(e.target.value);
                    // Auto-adjust stems based on model capability
                    const m = DEMUCS_MODELS.find(dm => dm.name === e.target.value);
                    if (m && m.stems === 6 && stems < 4) setStems(4);
                  }}
                  disabled={processing}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                  {DEMUCS_MODELS.map(m => (
                    <option key={m.name} value={m.name}>{m.description} ({m.stems} stems)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                  {t('stemQuality')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['rapida', 'alta', 'maxima'] as Quality[]).map(q => (
                    <button
                      key={q}
                      onClick={() => !processing && setQuality(q)}
                      disabled={processing}
                      className={`px-2 py-2 rounded-lg text-xs font-medium transition-all border ${
                        quality === q
                          ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-600 dark:text-indigo-400'
                          : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                      } disabled:opacity-50`}
                    >
                      {qualityLabels[q]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* UVR model selector */}
          {backend === 'uvr' && (
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                {t('stemModel')}
              </label>
              <select
                value={uvrModel}
                onChange={(e) => setUvrModel(e.target.value)}
                disabled={processing}
                className="w-full px-3 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              >
                {UVR_MODELS.map(m => (
                  <option key={m.name} value={m.name}>{m.description}</option>
                ))}
              </select>
            </div>
          )}

          {/* RoFormer model selector */}
          {backend === 'roformer' && (
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                {t('stemModel')}
              </label>
              <select
                value={roformerModel}
                onChange={(e) => setRoformerModel(e.target.value)}
                disabled={processing}
                className="w-full px-3 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              >
                {ROFORMER_MODELS.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.description}{m.badge ? ` ★` : ''}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[11px] text-amber-300/90">
                  {t('stemRoformerDownloadNote')}
                </p>
              </div>
            </div>
          )}

          {/* Stem count (hidden for roformer — only 2-stem) */}
          {backend !== 'roformer' && (
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Stems
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => !processing && setStems(2)}
                disabled={processing}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                  stems === 2
                    ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-600 dark:text-indigo-400'
                    : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                } disabled:opacity-50`}
              >
                2 — Vocals + Instrumental
              </button>
              <button
                onClick={() => !processing && setStems(4)}
                disabled={processing}
                title={backend === 'uvr' ? 'UVR 4-stem: vocal extraction + Demucs for drums/bass/other' : undefined}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                  stems === 4
                    ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-600 dark:text-indigo-400'
                    : 'bg-zinc-100 dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10'
                } disabled:opacity-50`}
              >
                4 — Vocals, Drums, Bass, Other
              </button>
            </div>
          </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Processing indicator */}
          {processing && (
            <div className="flex items-center gap-3 px-3 py-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
              <Loader2 size={20} className="animate-spin text-indigo-400" />
              <div>
                <p className="text-sm font-medium text-indigo-300">{t('stemProcessing')}</p>
                <p className="text-xs text-zinc-500 mt-0.5">{t('stemProcessingHint')}</p>
              </div>
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('stemResults')}</p>
                {elapsed != null && (
                  <span className="text-xs text-zinc-500">{elapsed.toFixed(1)}s</span>
                )}
              </div>
              <div className="space-y-1.5">
                {(Object.entries(results) as [string, StemResult][]).map(([name, stem]) => (
                  <div
                    key={name}
                    className="flex items-center gap-3 px-3 py-2.5 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-xl group"
                  >
                    <span className={STEM_COLORS[name] || 'text-zinc-400'}>
                      {STEM_ICONS[name] || <Music size={16} />}
                    </span>
                    <span className="flex-1 text-sm font-medium text-zinc-800 dark:text-zinc-200 capitalize">
                      {name}
                    </span>
                    <button
                      onClick={() => handlePlayStem(name, stem.url)}
                      className="p-1.5 text-zinc-400 hover:text-indigo-400 transition-colors"
                      title={playingStem === name ? t('pause') : t('play')}
                    >
                      {playingStem === name ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      onClick={() => handleDownloadStem(stem.url, stem.filename)}
                      className="p-1.5 text-zinc-400 hover:text-green-400 transition-colors"
                      title={t('download')}
                    >
                      <Download size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-white/10 flex items-center gap-2">
          {results ? (
            <>
              <button
                onClick={handleDownloadAll}
                className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <Download size={16} />
                {t('stemDownloadAll')}
              </button>
              <button
                onClick={() => { setResults(null); setElapsed(null); setError(null); }}
                className="px-4 py-2.5 bg-zinc-200 dark:bg-white/10 hover:bg-zinc-300 dark:hover:bg-white/15 text-zinc-800 dark:text-zinc-200 text-sm font-medium rounded-xl transition-colors"
              >
                {t('stemNewSeparation')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={processing}
                className="px-4 py-2.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-white text-sm transition-colors disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSeparate}
                disabled={processing || !song.audioUrl || !backendReady}
                className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:cursor-not-allowed"
              >
                {processing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t('stemProcessing')}
                  </>
                ) : (
                  <>
                    <Music size={16} />
                    {t('stemSeparate')}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

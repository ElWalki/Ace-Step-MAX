import { useCallback, useEffect, useState } from 'react';
import { Mic, RefreshCw, Trash2, Check, Loader2, AlertTriangle } from 'lucide-react';

export type VoiceEntry = {
  name: string;
  path: string;
  finalLoraPath: string | null;
  checkpoints: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

interface VoiceLibraryProps {
  token: string | null;
  activeLoraPath?: string;
  /** Called when the user clicks "Use" on a voice LoRA. Receives an absolute path. */
  onActivate: (voicePath: string, voiceName: string) => void | Promise<void>;
  /** Optional callback when the user wants to open the training studio for a new voice. */
  onCreateNew?: () => void;
}

/**
 * Voice LoRA library panel.
 *
 * Lists trained voice LoRAs stored under `lora_library/voice/<name>/`.
 * Each voice has a `final_lora` (preferred) and optional checkpoints.
 * Activating a voice loads it through the standard LoRA loader.
 */
export default function VoiceLibrary({ token, activeLoraPath, onActivate, onCreateNew }: VoiceLibraryProps) {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchVoices = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/training/voice-loras', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVoices(Array.isArray(data?.voices) ? data.voices : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load voice library');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void fetchVoices(); }, [fetchVoices]);

  // External refresh trigger: any component can dispatch
  // `window.dispatchEvent(new CustomEvent('voice-library:refresh'))` to force
  // a reload, e.g. after a voice training run finishes.
  useEffect(() => {
    const handler = () => { void fetchVoices(); };
    window.addEventListener('voice-library:refresh', handler);
    return () => window.removeEventListener('voice-library:refresh', handler);
  }, [fetchVoices]);

  const handleActivate = async (v: VoiceEntry) => {
    const target = v.finalLoraPath || v.checkpoints[v.checkpoints.length - 1] || v.path;
    setBusy(v.name);
    try {
      await onActivate(target, v.name);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (v: VoiceEntry) => {
    if (!token) return;
    const ok = window.confirm(`Eliminar "${v.name}"? Esto borrará la carpeta completa.`);
    if (!ok) return;
    setBusy(v.name);
    try {
      const res = await fetch(`/api/training/voice-loras/${encodeURIComponent(v.name)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchVoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const fmtMinutes = (m: unknown) => {
    const n = typeof m === 'number' ? m : Number(m);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `${n.toFixed(1)} min`;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Mic size={12} className="text-rose-500" />
          <span className="text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Voice Library</span>
          {voices.length > 0 && (
            <span className="text-[10px] text-zinc-400">({voices.length})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void fetchVoices()}
            title="Refresh"
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-500"
            disabled={loading}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
          {onCreateNew && (
            <button
              type="button"
              onClick={onCreateNew}
              className="px-2 py-1 rounded-md text-[10px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 ring-1 ring-rose-500/20"
              title="Entrenar un nuevo Voice LoRA"
            >
              + Train
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-[10px] text-red-500">
          <AlertTriangle size={11} /> {error}
        </div>
      )}

      {!loading && voices.length === 0 && !error && (
        <div className="text-[10px] text-zinc-500 italic">
          No hay voice LoRAs todavía. Entrena una desde Training Panel con preset Voice (rank 16, ~80 epochs, 5–30 min de audio).
        </div>
      )}

      <div className="space-y-1">
        {voices.map(v => {
          const targetPath = v.finalLoraPath || v.checkpoints[v.checkpoints.length - 1] || v.path;
          const active = !!activeLoraPath && (activeLoraPath === targetPath || activeLoraPath.includes(`/voice/${v.name}/`));
          const minutes = fmtMinutes(v.metadata?.dataset_minutes);
          const baseModel = typeof v.metadata?.base_model === 'string' ? (v.metadata.base_model as string) : null;
          return (
            <div
              key={v.name}
              className={`group flex items-center gap-2 p-1.5 rounded-md border transition-colors ${
                active
                  ? 'bg-rose-500/10 border-rose-500/30'
                  : 'bg-zinc-50 dark:bg-white/[0.03] border-zinc-100 dark:border-white/5 hover:bg-zinc-100 dark:hover:bg-white/[0.06]'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{v.name}</span>
                  {active && <Check size={11} className="text-rose-500 shrink-0" />}
                  {!v.finalLoraPath && (
                    <span className="text-[9px] text-amber-500" title="Sin final_lora, se usará último checkpoint">draft</span>
                  )}
                </div>
                <div className="text-[10px] text-zinc-400 truncate">
                  {[minutes, baseModel].filter(Boolean).join(' · ') || (v.checkpoints.length ? `${v.checkpoints.length} ckpt` : 'sin metadata')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleActivate(v)}
                disabled={busy === v.name}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                  active
                    ? 'bg-rose-500 text-white'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25'
                } disabled:opacity-50`}
                title={active ? 'Active voice' : `Use ${v.name}`}
              >
                {busy === v.name ? <Loader2 size={11} className="animate-spin" /> : (active ? 'Active' : 'Use')}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(v)}
                disabled={busy === v.name}
                className="p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import React, { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Wand2, Upload, X, Dice5, Loader2, Mic, Music, Sliders, Piano, Save, FolderOpen, Trash2, Cpu, ChevronDown, Check, Palette, Download, RefreshCw, Disc3, Paintbrush, ListMusic, Info, RotateCcw, Pin, PinOff, Lock, Unlock, Eraser } from 'lucide-react';
import CollapsibleSection from '../ui/CollapsibleSection';
import SliderField from '../ui/SliderField';
import SelectField from '../ui/SelectField';
import ToggleField from '../ui/ToggleField';
import AudioSections, { AudioHistoryItem, AudioTab } from './AudioSections';
import ChordEditor from './ChordEditor';
import SectionControls, { SECTION_TAGS } from './SectionControls';
import LoraManager from './LoraManager';
import MicRecorder from './MicRecorder';
import GpuMiniBar from './GpuMiniBar';
import SnippetMenu, { Snippet } from './SnippetMenu';
import DropdownPortal from '../ui/DropdownPortal';
import QuickParamsPanel from './QuickParamsPanel';
import StyleDnaPanel from './StyleDnaPanel';
import InfoPanel from '../ui/InfoPanel';
import {
  GenerationParams, DEFAULT_PARAMS,
  KEY_SIGNATURES, TIME_SIGNATURES, VOCAL_LANGUAGES,
  ChordProgressionState, ChordApplyData,
  StyleDna, DEFAULT_STYLE_DNA, buildStyleDnaTags, styleDnaToModelParams,
  TagCadence, DEFAULT_TAG_CADENCES, buildTagCadenceHints,
  CAPTION_BOOSTERS, TIMESTEP_SHAPES, GENERATION_MODES, validateTimesteps, detectGenerationMode, buildTimestepSchedule,
  TimestepShape, consistencyToParams, CONSISTENCY_NEUTRAL,
} from '../../types';
import { generateApi, preferencesApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useInfoPanel } from '../../context/InfoPanelContext';

interface CreatePanelProps {
  onGenerate: (params: GenerationParams) => void;
  isGenerating: boolean;
  activeJobCount: number;
  reuseParams?: GenerationParams | null;
  onReuseConsumed?: () => void;
  generationProgress?: number;
  generationStage?: string;
}

// Lightweight audio duration probe (reads metadata only, no full decode). 0 if unknown.
function probeAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const a = new Audio();
      a.preload = 'metadata';
      let settled = false;
      const done = (v: number) => { if (settled) return; settled = true; try { a.src = ''; } catch { /* noop */ } resolve(v > 0 && isFinite(v) ? v : 0); };
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(0);
      a.src = url;
      setTimeout(() => done(0), 4000);
    } catch { resolve(0); }
  });
}

// Working-draft persistence: survive browser refresh/crash without losing the form config.
const DRAFT_PARAMS_KEY = 'prodia_draft_params';
// Heavy/transient fields that must NOT be written to localStorage (data URLs can be many MB and
// would blow the ~5 MB quota, silently discarding the whole draft).
// LoRA fields are SERVER state, not form state — persisting them resurrected unloaded adapters.
const DRAFT_EXCLUDE_KEYS: (keyof GenerationParams)[] = [
  'referenceAudioUrl', 'sourceAudioUrl', 'vocalAudioUrl', 'audioCodes',
  'loraPath', 'loraName', 'loraLoaded', 'loraEnabled', 'loraScale', 'loraTriggerTag', 'loraTagPosition',
];

// Per-field saved texts (prompt / style / lyrics), reusable within and across sessions
type SnippetStore = { prompts: Snippet[]; styles: Snippet[]; lyrics: Snippet[] };
const EMPTY_SNIPPETS: SnippetStore = { prompts: [], styles: [], lyrics: [] };

function buildDraft(params: GenerationParams): Partial<GenerationParams> {
  const draft: Record<string, unknown> = { ...params };
  for (const k of DRAFT_EXCLUDE_KEYS) delete draft[k as string];
  // Also drop any residual data: URLs that slipped through under other keys.
  for (const [k, v] of Object.entries(draft)) {
    if (typeof v === 'string' && v.startsWith('data:')) delete draft[k];
  }
  return draft as Partial<GenerationParams>;
}

export default memo(function CreatePanel({ onGenerate, isGenerating, activeJobCount, reuseParams, onReuseConsumed, generationProgress, generationStage }: CreatePanelProps) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const infoPanel = useInfoPanel();
  const [params, setParams] = useState<GenerationParams>(() => {
    // Restore the guidance scale from a previous session when the user "locked" it
    const base = { ...DEFAULT_PARAMS };
    try {
      if (localStorage.getItem('prodia_pin_guidance') === 'true') {
        const saved = localStorage.getItem('prodia_guidance_value');
        const v = saved != null ? parseFloat(saved) : NaN;
        if (!Number.isNaN(v)) base.guidanceScale = v;
      }
    } catch { /* ignore */ }
    // Restore the full working draft so a browser refresh/crash doesn't wipe the form
    try {
      const draftRaw = localStorage.getItem(DRAFT_PARAMS_KEY);
      if (draftRaw) {
        const draft = JSON.parse(draftRaw);
        if (draft && typeof draft === 'object') return { ...base, ...draft };
      }
    } catch { /* ignore */ }
    return base;
  });
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    text: true, music: true, voice: false, styleDna: false, generation: false,
    lm: false, audio: false, expert: false, experimental: false,
  });
  const [styleDna, setStyleDna] = useState<StyleDna>({ ...DEFAULT_STYLE_DNA });
  const [tagCadences, setTagCadences] = useState<Record<string, TagCadence>>({ ...DEFAULT_TAG_CADENCES });
  const [isEnhancing, setIsEnhancing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srcFileInputRef = useRef<HTMLInputElement>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const simpleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const styleTextareaRef = useRef<HTMLTextAreaElement>(null);

  // LoRA state
  const [showLoraManager, setShowLoraManager] = useState(false);
  const [stickyTools, setStickyTools] = useState<boolean>(() => {
    try { return localStorage.getItem('prodia_sticky_tools') !== 'false'; } catch { return true; }
  });
  // When locked, the guidance scale value is remembered across app restarts
  const [pinGuidance, setPinGuidance] = useState<boolean>(() => {
    try { return localStorage.getItem('prodia_pin_guidance') === 'true'; } catch { return false; }
  });
  const [loraLoaded, setLoraLoaded] = useState(false);
  const [loraEnabled, setLoraEnabled] = useState(true);
  const [loraScale, setLoraScale] = useState(1.0);
  const [loraPath, setLoraPath] = useState('');
  const [loraTriggerTag, setLoraTriggerTag] = useState('');
  const [loraTagPosition, setLoraTagPosition] = useState('prepend');
  const [selectedLoraName, setSelectedLoraName] = useState('');
  const [loraWarning, setLoraWarning] = useState('');
  const [tagQuery, setTagQuery] = useState<string | null>(null);

  // Chord editor state
  const [chordState, setChordState] = useState<ChordProgressionState>({
    key: 'C', scale: 'major', roman: 'I - V - vi - IV', bpm: 120, beatsPerChord: 2,
  });
  const [showChordModal, setShowChordModal] = useState(false);

  // Template state — persisted server-side (survives browser change & restart), with localStorage cache
  const TEMPLATES_KEY = 'prodia_templates';
  const prefsRef = useRef<Record<string, unknown>>({});
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; params: GenerationParams }[]>(() => {
    try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]'); } catch { return []; }
  });
  const persistTemplates = useCallback((updated: { name: string; params: GenerationParams }[]) => {
    setSavedTemplates(updated);
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(updated));
    if (token) {
      prefsRef.current = { ...prefsRef.current, templates: updated };
      preferencesApi.set(prefsRef.current, token).catch(() => {});
    }
  }, [token]);
  const saveTemplate = useCallback(() => {
    const name = templateName.trim() || `Template ${savedTemplates.length + 1}`;
    const updated = [...savedTemplates.filter(t => t.name !== name), { name, params: { ...params } }];
    persistTemplates(updated);
    setTemplateName('');
    setShowTemplateMenu(false);
  }, [templateName, savedTemplates, params, persistTemplates]);
  const loadTemplate = useCallback((t: { name: string; params: GenerationParams }) => {
    setParams(p => ({ ...p, ...t.params }));
    setShowTemplateMenu(false);
  }, []);
  const deleteTemplate = useCallback((name: string) => {
    persistTemplates(savedTemplates.filter(t => t.name !== name));
  }, [savedTemplates, persistTemplates]);

  // Snippet state — saved prompts/styles/lyrics, persisted like templates (server + localStorage cache)
  const SNIPPETS_KEY = 'prodia_snippets';
  const [snippets, setSnippets] = useState<SnippetStore>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SNIPPETS_KEY) || '{}');
      return { ...EMPTY_SNIPPETS, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch { return { ...EMPTY_SNIPPETS }; }
  });
  const persistSnippets = useCallback((updated: SnippetStore) => {
    setSnippets(updated);
    try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
    if (token) {
      prefsRef.current = { ...prefsRef.current, snippets: updated };
      preferencesApi.set(prefsRef.current, token).catch(() => {});
    }
  }, [token]);
  const saveSnippet = useCallback((kind: keyof SnippetStore, name: string, value: string) => {
    persistSnippets({ ...snippets, [kind]: [...snippets[kind].filter(s => s.name !== name), { name, value }] });
  }, [snippets, persistSnippets]);
  const deleteSnippet = useCallback((kind: keyof SnippetStore, name: string) => {
    persistSnippets({ ...snippets, [kind]: snippets[kind].filter(s => s.name !== name) });
  }, [snippets, persistSnippets]);

  // Restore all creation parameters to their defaults ("undo" if settings go wrong)
  const handleResetParams = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm(t('create.resetConfirm', 'Restore all parameters to their default values?'))) return;
    setParams({ ...DEFAULT_PARAMS });
    setStyleDna({ ...DEFAULT_STYLE_DNA });
    setTagCadences({ ...DEFAULT_TAG_CADENCES });
    try { localStorage.removeItem(DRAFT_PARAMS_KEY); } catch { /* ignore */ }
  }, [t]);

  // BPM auto mode: 0 = backend auto-detects tempo (from style / reference / cover audio)
  const lastManualBpmRef = useRef(120);
  const toggleAutoBpm = useCallback(() => {
    setParams(p => {
      if (p.bpm === 0) return { ...p, bpm: lastManualBpmRef.current || 120 };
      if (p.bpm > 0) lastManualBpmRef.current = p.bpm;
      return { ...p, bpm: 0 };
    });
  }, []);

  // Experimental: toggle a caption booster on/off individually
  const toggleBooster = useCallback((id: string) => {
    setParams(p => {
      const cur = p.captionBoosters || [];
      return {
        ...p,
        captionBoosters: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id],
      };
    });
  }, []);

  const timestepsCheck = useMemo(() => validateTimesteps(params.customTimesteps), [params.customTimesteps]);
  const generationMode = detectGenerationMode(params);
  // Plain (non-XL) base checkpoint's generate_audio() has no `timesteps` kwarg — silently ignored there.
  const timestepsUnsupported = params.ditModel === 'acestep-v15-base';
  const [tsShape, setTsShape] = useState<TimestepShape>('linear');
  const [tsSteps, setTsSteps] = useState<number>(params.inferenceSteps);
  const applyTimestepShape = useCallback((shape: TimestepShape, steps: number) => {
    setTsShape(shape);
    setParams(p => ({ ...p, customTimesteps: buildTimestepSchedule(steps, shape) }));
  }, []);

  // Consistency macro: local slider position; applying overwrites the underlying LM/DiT knobs
  const [consistency, setConsistency] = useState<number>(CONSISTENCY_NEUTRAL);
  const applyConsistency = useCallback((level: number) => {
    setConsistency(level);
    setParams(p => ({ ...p, ...consistencyToParams(level) }));
  }, []);

  // DIT Model options — fallback labels for known models
  const MODEL_LABELS: Record<string, { label: string; color: string }> = {
    'acestep-v15-xl-base': { label: 'XL Base', color: 'fuchsia' },
    'acestep-v15-xl-sft': { label: 'XL SFT', color: 'fuchsia' },
    'acestep-v15-xl-turbo': { label: 'XL Turbo', color: 'fuchsia' },
    'acestep-v15-sft': { label: 'SFT', color: 'accent' },
    'acestep-v15-base': { label: 'Base', color: 'emerald' },
    'acestep-v15-turbo': { label: 'Turbo', color: 'amber' },
    'acestep-v15-turbo-shift1': { label: 'Turbo Shift1', color: 'amber' },
    'acestep-v15-turbo-shift3': { label: 'Turbo Shift3', color: 'amber' },
    'acestep-v15-turbo-continuous': { label: 'Turbo Cont.', color: 'amber' },
  };

  // Model status — which models are available in backend checkpoints
  const [availableModels, setAvailableModels] = useState<{ name: string; is_active: boolean; is_preloaded: boolean }[]>([]);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadPct, setModelLoadPct] = useState<number | null>(null);
  const [downloadingModels, setDownloadingModels] = useState<Record<string, { progress: string; status: string }>>({});
  const [pendingDownload, setPendingDownload] = useState<string | null>(null);
  const downloadPollRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const templateBtnRef = useRef<HTMLButtonElement>(null);

  // Close dropdowns on outside click (template menu handles its own via DropdownPortal)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showModelMenu && modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelMenu]);

  const set = useCallback(<K extends keyof GenerationParams>(key: K, val: GenerationParams[K]) => {
    setParams(p => ({ ...p, [key]: val }));
  }, []);

  // Persist the guidance scale between sessions while it is locked
  useEffect(() => {
    if (!pinGuidance) return;
    try { localStorage.setItem('prodia_guidance_value', String(params.guidanceScale)); } catch { /* ignore */ }
  }, [pinGuidance, params.guidanceScale]);

  // Auto-save the working draft (debounced) so a browser refresh/crash never wipes the config.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_PARAMS_KEY, JSON.stringify(buildDraft(params)));
      } catch { /* quota exceeded or serialization issue — ignore */ }
    }, 400);
    return () => clearTimeout(id);
  }, [params]);

  // Fetch available models from backend on mount (scans checkpoints/ on disk)
  const refreshModels = useCallback(() => {
    generateApi.getAllModels().then(r => {
      setAvailableModels(r.models);
      // If no model selected yet, pick the active one or first preloaded
      if (!params.ditModel) {
        const active = r.models.find(m => m.is_active);
        const preloaded = r.models.find(m => m.is_preloaded);
        if (active) set('ditModel', active.name);
        else if (preloaded) set('ditModel', preloaded.name);
      }
    }).catch(() => {
      // Fallback: try Gradio /v1/models for the loaded model
      generateApi.getLoadedModels().then(r => {
        setAvailableModels(r.models.map(m => ({ name: m.name, is_active: m.is_default, is_preloaded: true })));
        if (!params.ditModel && r.default_model) set('ditModel', r.default_model);
      }).catch(() => {});
    });
  }, [params.ditModel, set]);

  useEffect(() => { refreshModels(); }, []);

  // Poll real model-loading progress (shard %) from the backend while a load runs.
  useEffect(() => {
    if (!modelLoading) { setModelLoadPct(null); return; }
    let active = true;
    const poll = () => {
      generateApi.getModelLoadStatus()
        .then(s => { if (active && s && typeof s.progress === 'number') setModelLoadPct(s.loading ? s.progress : null); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 700);
    return () => { active = false; clearInterval(id); };
  }, [modelLoading]);

  // Load/swap a DiT model when user clicks it
  const handleLoadModel = useCallback(async (modelName: string) => {
    set('ditModel', modelName);
    setShowModelMenu(false);
    // Only call the load API if the model is on disk and not already active
    const model = availableModels.find(m => m.name === modelName);
    if (model?.is_active) return; // already loaded
    if (!model?.is_preloaded) return; // not on disk, can't load
    setModelLoading(true);
    try {
      await generateApi.loadModel(modelName, token || '');
      // Purge leftover VRAM from the previous model
      await fetch('/api/vram/purge', { method: 'POST' }).catch(() => {});
      // Swapping the model RE-INITIALIZES it and discards the LoRA server-side,
      // so re-apply the selected LoRA to keep it active (and the UI truthful).
      if (loraLoaded && loraPath) {
        try {
          await generateApi.loadLora({ lora_path: loraPath }, token || '');
          // load_lora resets the scale to 1.0 → restore the user's value (or disable).
          await generateApi.setLoraScale({ scale: loraEnabled ? loraScale : 0 }, token || '').catch(() => {});
        } catch { /* re-apply failed — non-fatal, status refresh will reflect it */ }
      }
      refreshModels();
    } catch {
      // Model swap failed — still selected in UI
    } finally {
      setModelLoading(false);
    }
  }, [availableModels, set, token, refreshModels, loraLoaded, loraPath, loraEnabled, loraScale]);

  // Cleanup download poll intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(downloadPollRef.current).forEach(clearInterval);
    };
  }, []);

  // Download a model from HuggingFace
  const handleDownloadModel = useCallback(async (modelName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloadingModels[modelName]) return;
    setDownloadingModels(prev => ({ ...prev, [modelName]: { progress: '0%', status: 'downloading' } }));
    try {
      await generateApi.downloadModel(modelName, token || '');
      // Start polling progress
      const pollId = setInterval(async () => {
        try {
          const res = await generateApi.getDownloadProgress(modelName);
          if (res.status === 'done') {
            clearInterval(pollId);
            delete downloadPollRef.current[modelName];
            setDownloadingModels(prev => {
              const next = { ...prev };
              delete next[modelName];
              return next;
            });
            refreshModels();
          } else if (res.status === 'error') {
            clearInterval(pollId);
            delete downloadPollRef.current[modelName];
            setDownloadingModels(prev => ({ ...prev, [modelName]: { progress: '', status: 'error' } }));
          } else {
            setDownloadingModels(prev => ({ ...prev, [modelName]: { progress: res.progress || '...', status: 'downloading' } }));
          }
        } catch {
          clearInterval(pollId);
          delete downloadPollRef.current[modelName];
          setDownloadingModels(prev => {
            const next = { ...prev };
            delete next[modelName];
            return next;
          });
        }
      }, 2000);
      downloadPollRef.current[modelName] = pollId;
    } catch {
      setDownloadingModels(prev => {
        const next = { ...prev };
        delete next[modelName];
        return next;
      });
    }
  }, [downloadingModels, token, refreshModels]);

  // LM model size & backend state
  const LM_SIZES = [
    { value: 'acestep-5Hz-lm-0.6B', label: '0.6B', vram: '~0.5 GB' },
    { value: 'acestep-5Hz-lm-1.7B', label: '1.7B', vram: '~1.5 GB' },
    { value: 'acestep-5Hz-lm-4B', label: '4B', vram: '~4 GB' },
  ];
  const [lmSwapping, setLmSwapping] = useState(false);
  const [currentLmModel, setCurrentLmModel] = useState<string | null>(null);
  const [currentLmBackend, setCurrentLmBackend] = useState<string | null>(null);

  // Fetch current LLM status on mount
  useEffect(() => {
    generateApi.getBackendStatus().then(s => {
      if (s.llm?.model) setCurrentLmModel(s.llm.model);
      if (s.llm?.backend) setCurrentLmBackend(s.llm.backend);
    }).catch(() => {});
  }, []);

  // Mic recorder
  const [showMicRecorder, setShowMicRecorder] = useState(false);
  const [micTarget, setMicTarget] = useState<'reference' | 'cover' | 'vocal'>('vocal');

  // Audio tab control (lifted from AudioSections)
  const [audioTab, setAudioTab] = useState<AudioTab>('reference');

  // Full-panel drag & drop
  const [panelDragging, setPanelDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // Audio history (recent uploads, persisted in localStorage)
  const AUDIO_HISTORY_KEY = 'acestep_audio_history';
  const [audioHistory, setAudioHistory] = useState<AudioHistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(AUDIO_HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const addToAudioHistory = useCallback((url: string, title: string) => {
    setAudioHistory(prev => {
      const filtered = prev.filter(h => h.url !== url);
      const updated = [{ url, title, timestamp: Date.now() }, ...filtered].slice(0, 20);
      localStorage.setItem(AUDIO_HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Colored lyrics toggle
  const [coloredLyrics, setColoredLyrics] = useState(true);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Consume reuseParams from parent
  useEffect(() => {
    if (reuseParams) {
      setParams(p => ({ ...p, ...reuseParams, customMode: true }));
      // Switch the audio input tab so the relevant controls become visible
      // (e.g. repaint region drag handles live in the Cover tab).
      if (reuseParams.taskType === 'repaint' || reuseParams.taskType === 'cover' || reuseParams.sourceAudioUrl) {
        setAudioTab('cover');
      } else if (reuseParams.taskType === 'extend') {
        setAudioTab('extend');
      } else if (reuseParams.referenceAudioUrl) {
        setAudioTab('reference');
      }
      onReuseConsumed?.();
    }
  }, [reuseParams, onReuseConsumed]);

  // Sync LoRA state from backend on mount (persists across browser change / restart)
  useEffect(() => {
    if (!token) return;
    generateApi.getLoraStatus(token).then(status => {
      if (status.loaded) {
        setLoraLoaded(true);
        setLoraEnabled(status.active);
        setLoraScale(status.scale ?? 1.0);
        setLoraPath(status.path);
        setLoraTriggerTag(status.trigger_tag ?? '');
        setLoraTagPosition(status.tag_position === 'replace' ? 'prepend' : status.tag_position ?? 'prepend');
        setSelectedLoraName(status.name ?? '');
        // Mirror into generation params so the loaded LoRA is actually applied when generating
        setParams(p => ({
          ...p,
          loraLoaded: true,
          loraEnabled: status.active,
          loraScale: status.scale ?? 1.0,
          loraPath: status.path,
          loraName: status.name ?? '',
          loraTriggerTag: status.trigger_tag ?? '',
        }));
      }
    }).catch(() => {});
    // Load server-side preferences (templates) — survives browser change & restart
    preferencesApi.get(token).then(({ data }) => {
      prefsRef.current = data || {};
      const serverTemplates = Array.isArray((data as { templates?: unknown })?.templates)
        ? (data as { templates: { name: string; params: GenerationParams }[] }).templates
        : null;
      const serverSnippets = (data as { snippets?: unknown })?.snippets;
      if (serverSnippets && typeof serverSnippets === 'object') {
        const merged = { ...EMPTY_SNIPPETS, ...(serverSnippets as SnippetStore) };
        setSnippets(merged);
        try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
      }
      if (serverTemplates && serverTemplates.length) {
        setSavedTemplates(serverTemplates);
        localStorage.setItem(TEMPLATES_KEY, JSON.stringify(serverTemplates));
      } else {
        // One-time migration: push any locally-cached templates up to the server
        try {
          const local = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
          if (Array.isArray(local) && local.length) {
            prefsRef.current = { ...prefsRef.current, templates: local };
            preferencesApi.set(prefsRef.current, token).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, [token]);

  // Swap LM model handler
  const handleSwapLm = useCallback(async (modelPath: string, backend: string, isActive = false) => {
    if (!token || lmSwapping) return;
    setLmSwapping(true);
    try {
      if (isActive) {
        // Clicking the already-loaded model unloads it from VRAM (toggle off).
        await generateApi.swapLlmModel('none', backend, token);
        setCurrentLmModel(null);
        setCurrentLmBackend(null);
      } else {
        const r = await generateApi.swapLlmModel(modelPath, backend, token);
        if (r.success) {
          setCurrentLmModel(r.model);
          setCurrentLmBackend(r.backend);
          set('lmModel', modelPath);
          set('lmBackend', backend as 'pt' | 'vllm');
        }
      }
    } catch { /* ignore */ } finally {
      setLmSwapping(false);
    }
  }, [token, lmSwapping, set]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleGenerate = useCallback(async () => {
    if (isGenerating && activeJobCount >= 4) return;

    let finalParams = { ...params };

    // Roll a FRESH random seed on every generation while "random seed" is enabled, so the
    // exact value is known, recorded with the song and shown on the clip (instead of a
    // static 0 or the last manual seed). We stamp it into `seed` here so it round-trips
    // through the backend and into the saved generation params. Single generations only —
    // multi-item batches keep engine-side per-variation seeding so the variations differ.
    if (finalParams.randomSeed && (finalParams.batchSize ?? 1) <= 1) {
      finalParams.seed = Math.floor(Math.random() * 4294967295) + 1;
    }

    // Duration 0 → auto (-1 for backend)
    if (finalParams.duration === 0) {
      finalParams.duration = -1;
    }

    // Never ship an invalid timestep schedule: the backend would either drop it or corrupt the take silently.
    const tsCheck = validateTimesteps(finalParams.customTimesteps);
    if (tsCheck && !tsCheck.ok) {
      finalParams.customTimesteps = undefined;
    }

    // Inject singer gender tag into the prompt/style
    if (finalParams.singer && !finalParams.instrumental) {
      const tag = finalParams.singer === 'male' ? 'male vocal' : 'female vocal';
      if (finalParams.customMode) {
        finalParams.style = finalParams.style
          ? `${finalParams.style}, ${tag}`
          : tag;
      } else {
        finalParams.songDescription = finalParams.songDescription
          ? `${finalParams.songDescription}, ${tag}`
          : tag;
      }
    }

    // Style DNA injection
    if (styleDna.enabled) {
      const dnaTags = buildStyleDnaTags(styleDna);
      if (dnaTags) {
        if (finalParams.customMode) {
          finalParams.style = finalParams.style
            ? `${finalParams.style}, ${dnaTags}`
            : dnaTags;
        } else {
          finalParams.songDescription = finalParams.songDescription
            ? `${finalParams.songDescription}, ${dnaTags}`
            : dnaTags;
        }
      }

      // Tag cadence hints — inject section delivery guidance into style
      const cadenceHints = buildTagCadenceHints(tagCadences);
      if (cadenceHints) {
        const cadenceTag = `[cadence: ${cadenceHints}]`;
        if (finalParams.customMode) {
          finalParams.style = finalParams.style
            ? `${finalParams.style}, ${cadenceTag}`
            : cadenceTag;
        } else {
          finalParams.songDescription = finalParams.songDescription
            ? `${finalParams.songDescription}, ${cadenceTag}`
            : cadenceTag;
        }
      }

      // Apply model-level param overrides from DNA
      const modelOverrides = styleDnaToModelParams(styleDna);
      if (modelOverrides.lmRepetitionPenalty !== undefined) {
        finalParams.lmRepetitionPenalty = modelOverrides.lmRepetitionPenalty;
      }
      if (modelOverrides.noRepeatNgramSize !== undefined) {
        finalParams.noRepeatNgramSize = modelOverrides.noRepeatNgramSize;
      }
      if (modelOverrides.apgEta !== undefined) {
        finalParams.apgEta = modelOverrides.apgEta;
      }
      finalParams.styleDna = styleDna;
    }

    // Caption boosters — individually toggled tag packs appended to the caption
    if (finalParams.captionBoosters?.length) {
      const boosterTags = CAPTION_BOOSTERS
        .filter(b => finalParams.captionBoosters!.includes(b.id))
        .map(b => b.tags)
        .join(', ');
      if (boosterTags) {
        if (finalParams.customMode) {
          finalParams.style = finalParams.style ? `${finalParams.style}, ${boosterTags}` : boosterTags;
        } else {
          finalParams.songDescription = finalParams.songDescription
            ? `${finalParams.songDescription}, ${boosterTags}`
            : boosterTags;
        }
      }
    }

    // Section mode overrides
    if (finalParams.sectionMode) {
      finalParams.batchSize = 1;
      finalParams.alignToMeasures = true;
      // Compute repetition penalty from melodic variation if not manually set
      const mv = (finalParams.melodicVariation ?? 0) / 100;
      if (!finalParams.lmRepetitionPenalty || finalParams.lmRepetitionPenalty === 1.0) {
        finalParams.lmRepetitionPenalty = 1.0 + mv * 0.5;
      }
    }

    // Repaint region: the UI stores the selection as a 0-1 fraction, but the repaint backend
    // expects ABSOLUTE SECONDS. Convert using the source audio duration before sending.
    if (finalParams.taskType === 'repaint' && finalParams.sourceAudioUrl) {
      const rs = finalParams.repaintingStart ?? 0;
      const re = finalParams.repaintingEnd ?? 1;
      // The region handles / expert sliders always produce a 0-1 fraction; convert those to seconds.
      if (rs >= 0 && rs <= 1 && re > 0 && re <= 1 && re > rs) {
        const dur = await probeAudioDuration(finalParams.sourceAudioUrl);
        if (dur > 0) {
          finalParams.repaintingStart = +(rs * dur).toFixed(2);
          finalParams.repaintingEnd = +(re * dur).toFixed(2);
        }
      }
    }

    onGenerate(finalParams);
  }, [isGenerating, activeJobCount, onGenerate, params, styleDna, tagCadences]);

  const handleRandomDescription = async () => {
    if (!token) return;
    try {
      const r = await generateApi.getRandomDescription(token);
      setParams(p => ({
        ...p,
        customMode: false,
        songDescription: r.description,
        instrumental: r.instrumental,
        vocalLanguage: r.vocalLanguage || 'en',
      }));
    } catch { /* ignore */ }
  };

  const handleEnhance = async () => {
    if (!token || isEnhancing) return;
    setIsEnhancing(true);
    try {
      const caption = params.customMode
        ? `${params.style || ''} ${params.prompt || ''}`.trim()
        : params.songDescription || '';
      if (!caption) return;
      const r = await generateApi.formatInput({
        caption,
        lyrics: params.lyrics || undefined,
        bpm: params.bpm || undefined,
        duration: params.duration || undefined,
        keyScale: params.keyScale || undefined,
        timeSignature: params.timeSignature || undefined,
      }, token);
      setParams(p => ({
        ...p,
        style: (r.caption as string) || p.style,
        lyrics: (r.lyrics as string) || p.lyrics,
        bpm: (r.bpm as number) || p.bpm,
        keyScale: (r.key_scale as string) || p.keyScale,
        duration: (r.duration as number) || p.duration,
      }));
    } catch { /* ignore */ } finally {
      setIsEnhancing(false);
    }
  };

  const handleFileUpload = async (file: File, target: 'reference' | 'source') => {
    if (!token) return;
    try {
      const r = await generateApi.uploadAudio(file, token);
      if (target === 'reference') {
        set('referenceAudioUrl', r.url);
        set('referenceAudioTitle', file.name);
      } else {
        set('sourceAudioUrl', r.url);
        set('sourceAudioTitle', file.name);
        set('taskType', 'cover');
      }
    } catch { /* ignore */ }
  };

  // LoRA handlers
  const handleLoraLoad = useCallback(async (path: string, name: string, variant: string, initialScale?: number) => {
    if (!token) return;
    try {
      const r = await generateApi.loadLora({ lora_path: path }, token);
      // Surface a base-model compatibility warning (e.g. an SFT/turbo LoRA on an XL model).
      setLoraWarning(r.message && /⚠|INCOMPATIBLE|mismatch/i.test(r.message) ? r.message : '');
      // Load resets Python handler scale to 1.0 — re-apply desired scale
      const desiredScale = initialScale ?? loraScale;
      if (desiredScale !== 1.0) {
        await generateApi.setLoraScale({ scale: desiredScale }, token).catch(() => {});
      }
      setLoraLoaded(true);
      setLoraEnabled(true);
      setLoraScale(desiredScale);
      setLoraPath(path);
      setSelectedLoraName(name);
      setLoraTriggerTag(r.trigger_tag ?? '');
      set('loraPath', path);
      set('loraName', name);
      set('loraLoaded', true);
      set('loraEnabled', true);
      set('loraScale', desiredScale);
      set('loraTriggerTag', r.trigger_tag ?? '');
    } catch { /* ignore */ }
  }, [token, set, loraScale]);

  const handleLoraUnload = useCallback(async () => {
    if (!token) return;
    try {
      await generateApi.unloadLora(token);
      setLoraLoaded(false);
      setLoraEnabled(false);
      setLoraScale(1.0);
      setLoraPath('');
      setSelectedLoraName('');
      setLoraTriggerTag('');
      setLoraWarning('');
      // Clear EVERY lora field from params — any leftover (loraName/Scale/Tag)
      // kept resurrecting the adapter in later requests
      setParams(p => ({
        ...p,
        loraLoaded: false,
        loraEnabled: false,
        loraPath: undefined,
        loraName: undefined,
        loraScale: undefined,
        loraTriggerTag: undefined,
        loraTagPosition: undefined,
      }));
    } catch { /* ignore */ }
  }, [token]);

  // Deep clean: force-remove ANY adapter server-side even when the panel thinks none
  // is loaded (e.g. auto-loaded by a repaint or left over from a previous session).
  const handleLoraDeepClean = useCallback(async () => {
    if (!token) return;
    try { await generateApi.setLoraScale({ scale: 0 }, token); } catch { /* ignore */ }
    try { await generateApi.unloadLora(token); } catch { /* ignore */ }
    setLoraLoaded(false);
    setLoraEnabled(false);
    setLoraScale(1.0);
    setLoraPath('');
    setSelectedLoraName('');
    setLoraTriggerTag('');
    setLoraWarning('');
    setParams(p => ({
      ...p,
      loraLoaded: false,
      loraEnabled: false,
      loraPath: undefined,
      loraName: undefined,
      loraScale: undefined,
      loraTriggerTag: undefined,
      loraTagPosition: undefined,
    }));
  }, [token]);

  const handleLoraToggle = useCallback(async () => {
    if (!token) return;
    const next = !loraEnabled;
    setLoraEnabled(next);
    set('loraEnabled', next);
    try { await generateApi.toggleLora({ enabled: next }, token); } catch { /* ignore */ }
  }, [token, loraEnabled, set]);

  const handleLoraTagPosition = useCallback(async (pos: string) => {
    if (!token) return;
    setLoraTagPosition(pos);
    set('loraTagPosition', pos);
    try { await generateApi.setLoraTagPosition({ position: pos }, token); } catch { /* ignore */ }
  }, [token, set]);

  // Chord apply — handles all injection modes
  const [chordApplyLoading, setChordApplyLoading] = useState<string | null>(null);
  const handleChordApply = useCallback(async (data: ChordApplyData) => {
    // Always set the text tags (key/scale context)
    setParams(p => ({
      ...p,
      style: p.style ? `${p.style}, ${data.styleTag}` : data.styleTag,
      ...(data.lyricsTag ? { lyrics: p.lyrics ? `${data.lyricsTag}\n${p.lyrics}` : data.lyricsTag } : {}),
      keyScale: data.keyScaleTag || p.keyScale,
    }));

    if (data.mode === 'style' || !data.audioBlob) return;

    // Audio modes: upload rendered WAV then apply
    if (!token) return;
    try {
      setChordApplyLoading(data.mode === 'audioCodes' ? 'Extracting audio codes…' : 'Uploading reference…');
      const file = new File([data.audioBlob], 'chord-progression.wav', { type: 'audio/wav' });
      const uploadResult = await generateApi.uploadAudio(file, token);

      if (data.mode === 'reference') {
        set('referenceAudioUrl', uploadResult.url);
        set('referenceAudioTitle', 'Chord Progression');
      } else if (data.mode === 'audioCodes') {
        setChordApplyLoading('Extracting audio codes…');
        const codesResult = await generateApi.extractAudioCodes(uploadResult.url, token);
        set('audioCodes', codesResult.audioCodes);
      }
    } catch (err) {
      console.error('Chord injection failed:', err);
    } finally {
      setChordApplyLoading(null);
    }
  }, [token, set]);

  // Audio sections upload
  const handleAudioSectionUpload = useCallback(async (file: File, target: 'reference' | 'source' | 'vocal') => {
    if (!token) return;
    try {
      const r = await generateApi.uploadAudio(file, token);
      addToAudioHistory(r.url, file.name);
      if (target === 'reference') {
        set('referenceAudioUrl', r.url);
        set('referenceAudioTitle', file.name);
      } else if (target === 'source') {
        set('sourceAudioUrl', r.url);
        set('sourceAudioTitle', file.name);
        set('taskType', 'cover');
      } else {
        set('vocalAudioUrl', r.url);
        set('vocalAudioTitle', file.name);
      }
    } catch { /* ignore */ }
  }, [token, set, addToAudioHistory]);

  // Handle selection from audio history list
  const handleHistorySelect = useCallback((item: AudioHistoryItem, target: 'reference' | 'source' | 'vocal') => {
    if (target === 'reference') {
      set('referenceAudioUrl', item.url);
      set('referenceAudioTitle', item.title);
    } else if (target === 'source') {
      set('sourceAudioUrl', item.url);
      set('sourceAudioTitle', item.title);
      set('taskType', 'cover');
    } else {
      set('vocalAudioUrl', item.url);
      set('vocalAudioTitle', item.title);
    }
  }, [set]);

  // Panel-level drag & drop handlers
  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setPanelDragging(true);
  }, []);
  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setPanelDragging(false); }
  }, []);
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handlePanelDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setPanelDragging(false);
    // Route to active audio tab
    const target = audioTab === 'reference' ? 'reference' as const : audioTab === 'vocal' ? 'vocal' as const : 'source' as const;
    // Check for song drag from workspace
    const songUrl = e.dataTransfer.getData('text/song-audio-url');
    const songTitle = e.dataTransfer.getData('text/song-title');
    if (songUrl) {
      addToAudioHistory(songUrl, songTitle || 'Untitled');
      if (target === 'reference') { set('referenceAudioUrl', songUrl); set('referenceAudioTitle', songTitle || 'Untitled'); }
      else if (target === 'source') { set('sourceAudioUrl', songUrl); set('sourceAudioTitle', songTitle || 'Untitled'); set('taskType', 'cover'); }
      else { set('vocalAudioUrl', songUrl); set('vocalAudioTitle', songTitle || 'Untitled'); }
      // Ensure custom mode is on and text section is open
      if (!params.customMode) set('customMode', true);
      setOpenSections(prev => ({ ...prev, text: true }));
      return;
    }
    // File drop
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('audio/')) {
      if (!params.customMode) set('customMode', true);
      setOpenSections(prev => ({ ...prev, text: true }));
      await handleAudioSectionUpload(file, target);
    }
  }, [audioTab, set, params.customMode, handleAudioSectionUpload, addToAudioHistory]);

  // Workflow mode handler — click an active mode again to turn it OFF (back to text2music)
  const handleWorkflowMode = useCallback((mode: 'cover' | 'repaint' | 'extend') => {
    const targetTask = mode === 'extend' ? 'complete' : mode;
    // Toggle off: if this mode is already active, return to normal text→music generation.
    if (params.taskType === targetTask) {
      set('taskType', undefined);
      set('sourceAudioUrl', undefined);
      set('sourceAudioTitle', undefined);
      set('audioCoverStrength', undefined);
      return;
    }
    set('customMode', true);
    setOpenSections(prev => ({ ...prev, text: true, expert: true }));
    set('taskType', targetTask);
    setAudioTab(mode === 'extend' ? 'extend' : 'cover');
  }, [set, params.taskType]);

  // Mic recording accept
  const handleMicAccept = useCallback(async (blob: Blob, filename: string) => {
    const file = new File([blob], filename, { type: blob.type });
    await handleAudioSectionUpload(file, micTarget === 'cover' ? 'source' : micTarget);
    setShowMicRecorder(false);
  }, [handleAudioSectionUpload, micTarget]);

  // Build tag→hex color map for lyrics coloring
  const tagColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    SECTION_TAGS.forEach(s => { map[s.tag.toLowerCase()] = s.hex; });
    return map;
  }, []);

  // Colorize lyrics lines based on current section tag
  const renderColoredLyrics = useCallback((text: string) => {
    const lines = text.split('\n');
    let currentColor = '#c8c8d8'; // default text color
    return lines.map((line, i) => {
      const trimmed = line.trim().toLowerCase();
      const matchTag = Object.keys(tagColorMap).find(t => trimmed === t || trimmed.startsWith(t));
      if (matchTag) currentColor = tagColorMap[matchTag];
      return (
        <div key={i} style={{ color: currentColor, minHeight: '1.5em', lineHeight: '1.5' }}>
          {line || '\u00a0'}
        </div>
      );
    });
  }, [tagColorMap]);

  // Insert section tag into lyrics
  const handleInsertSectionTag = useCallback((tag: string) => {
    const textarea = lyricsRef.current;
    if (!textarea) {
      set('lyrics', `${tag}\n${params.lyrics || ''}`);
      return;
    }
    const start = textarea.selectionStart;
    const text = params.lyrics || '';
    const before = text.slice(0, start);
    const after = text.slice(start);
    // Blank line before tag (unless at start or already has blank line)
    const needsBlankBefore = before.length > 0 && !before.endsWith('\n\n') && !before.endsWith('\n');
    const needsNewlineBefore = before.length > 0 && !before.endsWith('\n');
    const prefix = needsBlankBefore ? '\n\n' : needsNewlineBefore ? '\n' : '';
    // Just one newline after tag — cursor goes right below
    const suffix = '\n';
    const inserted = `${prefix}${tag}${suffix}`;
    set('lyrics', `${before}${inserted}${after}`);
    const cursorPos = start + inserted.length;
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = cursorPos;
      textarea.focus();
    });
  }, [params.lyrics, set]);

  const keyOptions = KEY_SIGNATURES.map(k => ({ value: k, label: k || 'Auto' }));
  const tsOptions = TIME_SIGNATURES.map(ts => ({ value: ts.value, label: ts.label }));
  const vocalOptions = VOCAL_LANGUAGES.map(l => ({ value: l.code, label: l.label }));
  const taskOptions = [
    { value: '', label: 'Auto' },
    { value: 'text2music', label: 'Text to Music' },
    { value: 'cover', label: 'Cover' },
    { value: 'repaint', label: 'Repaint' },
    { value: 'complete', label: 'Extend (Complete)' },
  ];

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handlePanelDragEnter}
      onDragLeave={handlePanelDragLeave}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      {/* Full-panel drop overlay */}
      {panelDragging && (
        <div className="absolute inset-0 z-40 bg-accent-500/10 border-2 border-dashed border-accent-500 rounded-xl flex flex-col items-center justify-center gap-2 backdrop-blur-[2px] pointer-events-none">
          <Upload className="w-8 h-8 text-accent-400 animate-bounce" />
          <span className="text-sm font-semibold text-accent-400">
            {t('audio.dropOverlay', { tab: t(`audio.${audioTab}`) })}
          </span>
          <span className="text-[10px] text-surface-500">
            {t('audio.dropOverlayHint', 'Drop anywhere on this panel')}
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {/* Model switcher + Templates bar */}
        <div className={`flex items-center gap-1.5 mb-1 flex-wrap ${stickyTools ? 'sticky top-0 z-20 -mx-4 px-4 -mt-4 pt-4 pb-2 bg-surface-50/95 backdrop-blur-sm border-b border-surface-200/60' : ''}`}>
          {/* DiT Model selector */}
          <div className="relative" ref={modelMenuRef}>
            <button
              onClick={() => setShowModelMenu(!showModelMenu)}
              disabled={modelLoading}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-100 border border-surface-300/40 hover:border-accent-500/40 transition-colors text-xs disabled:opacity-60"
            >
              {modelLoading
                ? <RefreshCw className="w-3 h-3 text-accent-400 animate-spin" />
                : <Cpu className="w-3 h-3 text-surface-400" />
              }
              <span className="font-semibold text-surface-800">
                {MODEL_LABELS[params.ditModel || '']?.label || params.ditModel || 'Select'}
              </span>
              {availableModels.some(m => m.name === params.ditModel && m.is_active) && (
                <Check className="w-3 h-3 text-green-400" />
              )}
              <ChevronDown className="w-3 h-3 text-surface-400" />
            </button>
            {showModelMenu && (
              <div className="absolute left-0 top-full mt-1 w-64 bg-surface-100 border border-surface-300 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-1.5 border-b border-surface-300/40 flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider">{t('create.ditModel', 'Model')}</span>
                  <span className="text-[10px] text-surface-400">{t('checkpoints.clickToLoad', 'Click to load')}</span>
                </div>
                {availableModels.length === 0 && (
                  <div className="px-3 py-3 text-[10px] text-surface-400 text-center">
                    {t('create.noModels', 'No models found in checkpoints/')}
                  </div>
                )}
                {availableModels.map(m => {
                  const info = MODEL_LABELS[m.name];
                  const isSelected = params.ditModel === m.name;
                  const displayLabel = info?.label || m.name.replace('acestep-v15-', '').replace('acestep-', '');
                  const dl = downloadingModels[m.name];
                  return (
                    <div
                      key={m.name}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 transition-colors ${
                        isSelected ? 'bg-accent-500/10' : 'hover:bg-surface-200'
                      }`}
                    >
                      <button
                        onClick={() => handleLoadModel(m.name)}
                        disabled={modelLoading}
                        className={`flex-1 min-w-0 text-left disabled:opacity-40 ${!m.is_preloaded ? 'opacity-70' : ''}`}
                        title={!m.is_preloaded ? 'Modelo no descargado — se seleccionará pero no se cargará hasta descargarlo' : undefined}
                      >
                        <span className={`text-xs font-semibold block ${isSelected ? 'text-accent-400' : 'text-surface-800'}`}>
                          {displayLabel}
                        </span>
                        <span className="text-[10px] text-surface-400 block truncate">{m.name}</span>
                      </button>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {m.is_active && (
                          <span className="text-[9px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.loaded', 'Loaded')}</span>
                        )}
                        {!m.is_preloaded && !dl && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setPendingDownload(m.name); }}
                            className="flex items-center gap-1 text-[9px] text-accent-400 bg-accent-500/10 hover:bg-accent-500/20 px-1.5 py-0.5 rounded font-medium transition-colors"
                            title={t('create.downloadModel', 'Download model')}
                          >
                            <Download className="w-3 h-3" />
                            {t('create.download', 'Download')}
                          </button>
                        )}
                        {dl && dl.status === 'downloading' && (
                          <span className="flex items-center gap-1 text-[9px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {dl.progress}
                          </span>
                        )}
                        {dl && dl.status === 'error' && (
                          <button
                            onClick={(e) => {
                              setDownloadingModels(prev => { const next = { ...prev }; delete next[m.name]; return next; });
                              handleDownloadModel(m.name, e);
                            }}
                            className="flex items-center gap-1 text-[9px] text-red-400 bg-red-500/10 hover:bg-red-500/20 px-1.5 py-0.5 rounded font-medium transition-colors"
                            title={t('create.retryDownload', 'Retry download')}
                          >
                            <RefreshCw className="w-3 h-3" />
                            {t('create.retry', 'Retry')}
                          </button>
                        )}
                        {isSelected && <Check className="w-3 h-3 text-accent-400" />}
                      </div>
                    </div>
                  );
                })}
                {availableModels.some(m => !m.is_preloaded && !downloadingModels[m.name]) && (
                  <div className="px-3 py-2 border-t border-surface-300/40">
                    <button
                      onClick={() => setPendingDownload('__all__')}
                      className="w-full flex items-center justify-center gap-1.5 text-[10px] text-accent-400 hover:text-accent-300 font-semibold transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      {t('create.downloadAll', 'Download all')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Quick load / download for the SELECTED model (beside the dropdown) */}
          {(() => {
            const modelName = params.ditModel;
            if (!modelName) return null;
            const sel = availableModels.find(m => m.name === modelName);
            const dl = downloadingModels[modelName];
            // Downloading → live progress
            if (dl?.status === 'downloading') {
              return (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/10 text-blue-400 text-[11px] font-medium">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {dl.progress}
                </span>
              );
            }
            // Not on disk → red Download button
            if (sel && !sel.is_preloaded) {
              return (
                <button
                  onClick={() => setPendingDownload(modelName)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-[11px] font-semibold transition-colors"
                  title={t('create.downloadModel', 'Download model')}
                >
                  <Download className="w-3 h-3" />
                  {t('create.download', 'Download')}
                </button>
              );
            }
            // On disk but not loaded → Load button
            if (sel?.is_preloaded && !sel.is_active) {
              return (
                <button
                  onClick={() => handleLoadModel(modelName)}
                  disabled={modelLoading}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-accent-500/10 border border-accent-500/30 text-accent-400 hover:bg-accent-500/20 text-[11px] font-semibold transition-colors disabled:opacity-50"
                  title={t('create.loadModel', 'Load selected model')}
                >
                  {modelLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Cpu className="w-3 h-3" />}
                  {t('create.loadBtn', 'Load')}
                </button>
              );
            }
            // Already loaded/active → nothing (the dropdown trigger shows the check)
            return null;
          })()}

          {/* Currently-loaded (active) checkpoint — shown when it differs from the selected one */}
          {(() => {
            const activeModel = availableModels.find(m => m.is_active);
            if (!activeModel || activeModel.name === params.ditModel) return null;
            const label = MODEL_LABELS[activeModel.name]?.label || activeModel.name.replace('acestep-v15-', '');
            return (
              <span
                className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-green-500/10 text-green-400 text-[10px] font-medium"
                title={`${t('create.activeCheckpoint', 'Loaded checkpoint')}: ${activeModel.name}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                {label}
              </span>
            );
          })()}

          {/* Real-time model-loading (checkpoint shards) progress */}
          {modelLoading && (
            <div className="flex items-center gap-1.5" title={t('create.loadingModel', 'Loading model…')}>
              <span className="text-[10px] text-accent-400 font-mono tabular-nums w-8 text-right">
                {modelLoadPct != null ? `${modelLoadPct}%` : '…'}
              </span>
              <div className="w-16 h-1 rounded-full bg-surface-300 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent-500 to-brand-500 transition-all duration-300 ease-out"
                  style={{ width: `${modelLoadPct ?? 10}%` }}
                />
              </div>
            </div>
          )}

          {/* LoRA selector — next to the model selector; opens the LoRA manager */}
          <button
            onClick={() => setShowLoraManager(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors ${
              loraLoaded
                ? (loraWarning ? 'bg-amber-500/10 border-amber-500/40 text-amber-400' : 'bg-brand-500/10 border-brand-500/30 text-brand-400')
                : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-brand-500/40'
            }`}
            title={loraLoaded ? (loraWarning || `LoRA: ${selectedLoraName}`) : t('lora.openManager', 'Open LoRA Manager')}
          >
            <Sliders className="w-3 h-3 shrink-0" />
            <span className="font-semibold truncate max-w-[90px]">{loraLoaded ? (selectedLoraName || 'LoRA') : 'LoRA'}</span>
            {loraLoaded && (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${loraWarning ? 'bg-amber-400' : (loraEnabled ? 'bg-green-400' : 'bg-surface-400')}`} />
            )}
          </button>

          {/* Deep-clean: force-unload any adapter even if the panel shows none loaded */}
          <button
            onClick={handleLoraDeepClean}
            className="p-1 rounded-md text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
            title={t('lora.deepClean', 'Limpieza profunda del LoRA: desactiva y descarga cualquier adaptador activo en el servidor (aunque aquí no aparezca cargado)')}
          >
            <Eraser className="w-3.5 h-3.5" />
          </button>

          {/* Pin/unpin the top toolbar (keep visible on scroll, or hide for a cleaner view) */}
          <button
            onClick={() => setStickyTools(v => { const n = !v; try { localStorage.setItem('prodia_sticky_tools', String(n)); } catch { /* ignore */ } return n; })}
            className={`p-1 rounded-md transition-colors shrink-0 ${stickyTools ? 'text-accent-400 bg-accent-500/10' : 'text-surface-400 hover:text-accent-400 hover:bg-surface-200'}`}
            title={stickyTools ? t('create.unpinTools', 'Unpin toolbar (hide on scroll)') : t('create.pinTools', 'Keep toolbar visible on scroll')}
          >
            {stickyTools ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
          </button>

          {/* Download Confirmation Dialog */}
          {pendingDownload && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center" onClick={() => setPendingDownload(null)}>
              <div className="bg-surface-100 border border-surface-300 rounded-2xl shadow-2xl w-80 p-5 animate-scale-in" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-accent-500/15 flex items-center justify-center">
                    <Download className="w-5 h-5 text-accent-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-surface-900">{t('create.confirmDownload', 'Download Model')}</h3>
                    <p className="text-[10px] text-surface-500">{t('create.fromHuggingFace', 'From HuggingFace')}</p>
                  </div>
                </div>
                <p className="text-xs text-surface-700 mb-1">
                  {pendingDownload === '__all__'
                    ? t('create.downloadAllConfirm', 'Download all missing models? This will use significant disk space and bandwidth.')
                    : t('create.downloadConfirm', 'Download {{model}}? Model files are typically 1-3 GB.', { model: MODEL_LABELS[pendingDownload]?.label || pendingDownload.replace('acestep-v15-', '') })
                  }
                </p>
                <p className="text-[10px] text-surface-400 mb-4">{t('create.downloadNote', 'The download will run in the background. You can continue working.')}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingDownload(null)}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium text-surface-700 bg-surface-200 hover:bg-surface-300 transition-colors"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    onClick={(e) => {
                      if (pendingDownload === '__all__') {
                        availableModels.filter(m => !m.is_preloaded && !downloadingModels[m.name]).forEach(m => handleDownloadModel(m.name, e));
                      } else {
                        handleDownloadModel(pendingDownload, e);
                      }
                      setPendingDownload(null);
                    }}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-accent-500 hover:bg-accent-600 transition-colors"
                  >
                    {t('create.download', 'Download')}
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="flex-1" />
          {/* Info panel toggle */}
          <button
            onClick={infoPanel.toggle}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${infoPanel.enabled ? 'text-accent-400 bg-accent-500/10' : 'text-surface-400 hover:text-accent-400 hover:bg-surface-200'}`}
            title={t('create.toggleInfoPanel', 'Info panel — explains each parameter, its value and range')}
          >
            <Info className="w-3.5 h-3.5" />
          </button>
          {/* Reset to defaults */}
          <button
            onClick={handleResetParams}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-surface-400 hover:text-amber-400 hover:bg-surface-200 transition-colors"
            title={t('create.resetParams', 'Restore default settings')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          {/* Template save/load */}
          <div className="relative">
            <button
              ref={templateBtnRef}
              onClick={() => setShowTemplateMenu(!showTemplateMenu)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-surface-400 hover:text-accent-400 hover:bg-surface-200 transition-colors"
              title={t('create.templates', 'Templates')}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('create.templates', 'Templates')}</span>
            </button>
            {showTemplateMenu && (
              <DropdownPortal anchorEl={templateBtnRef.current} width={224} align="right" onClose={() => setShowTemplateMenu(false)}>
                <div className="px-3 py-2 border-b border-surface-300/40">
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={templateName}
                      onChange={e => setTemplateName(e.target.value)}
                      placeholder={t('create.templateName', 'Template name...')}
                      className="flex-1 bg-surface-200 rounded-md px-2 py-1 text-xs text-surface-900 placeholder:text-surface-400"
                      onKeyDown={e => e.key === 'Enter' && saveTemplate()}
                    />
                    <button
                      onClick={saveTemplate}
                      className={`p-1.5 rounded-md text-white transition-colors ${
                        savedTemplates.some(t => t.name === templateName.trim()) ? 'bg-amber-500 hover:bg-amber-400' : 'bg-accent-500 hover:bg-accent-400'
                      }`}
                      title={savedTemplates.some(t => t.name === templateName.trim()) ? t('create.overwriteTemplate', 'Overwrite existing template') : t('create.saveTemplate', 'Save current settings')}
                    >
                      <Save className="w-3 h-3" />
                    </button>
                  </div>
                  {templateName.trim() && savedTemplates.some(t => t.name === templateName.trim()) && (
                    <p className="text-[10px] text-amber-400 mt-1">{t('create.templateExists', 'Will overwrite existing template')}</p>
                  )}
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {savedTemplates.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-surface-400 text-center">{t('create.noTemplates', 'No saved templates')}</p>
                  ) : savedTemplates.map((tpl, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-200 transition-colors group">
                      <button
                        onClick={() => loadTemplate(tpl)}
                        className="flex-1 text-left text-xs text-surface-800 font-medium truncate"
                      >
                        {tpl.name}
                      </button>
                      <button
                        onClick={() => deleteTemplate(tpl.name)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded text-red-400 hover:bg-red-500/10 transition-all"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </DropdownPortal>
            )}
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => set('customMode', false)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              !params.customMode ? 'bg-accent-500 text-white' : 'bg-surface-200 text-surface-500 hover:bg-surface-300'
            }`}
          >
            {t('create.simpleMode')}
          </button>
          <button
            onClick={() => set('customMode', true)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              params.customMode ? 'bg-accent-500 text-white' : 'bg-surface-200 text-surface-500 hover:bg-surface-300'
            }`}
          >
            {t('create.advancedMode')}
          </button>
          <div className="flex-1" />
          <button
            onClick={handleRandomDescription}
            className="p-1.5 rounded-md text-surface-400 hover:text-accent-500 hover:bg-surface-200"
            title="Random idea"
          >
            <Dice5 className="w-4 h-4" />
          </button>
          <button
            onClick={handleEnhance}
            disabled={isEnhancing}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-surface-200 text-surface-500 hover:bg-accent-500/20 hover:text-accent-400 disabled:opacity-50"
          >
            {isEnhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            {t('create.enhance')}
          </button>
        </div>

        {/* Advanced master switch: turn OFF to force a clean text→music generation,
            ignoring any reference/cover/source audio still loaded in the UI. */}
        {params.customMode && (
          <ToggleField
            label={t('create.useAudioInput', 'Usar audio de entrada (cover / referencia)')}
            value={!params.ignoreAudioInput}
            onChange={v => set('ignoreAudioInput', !v)}
            tooltip={t('tooltip.useAudioInput', 'Apágalo para forzar texto → música limpio, ignorando cualquier audio de referencia o cover cargado.')}
          />
        )}

        {/* Workflow mode presets */}
        {!params.ignoreAudioInput && (
        <div className="flex gap-1.5">
          <button
            onClick={() => handleWorkflowMode('cover')}
            className={`flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
              params.taskType === 'cover'
                ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-blue-500/30 hover:text-blue-400'
            }`}
          >
            <Disc3 className="w-3.5 h-3.5" />
            {t('workflow.cover', 'Cover')}
          </button>
          <button
            onClick={() => handleWorkflowMode('repaint')}
            className={`flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
              params.taskType === 'repaint'
                ? 'bg-purple-500/15 border-purple-500/40 text-purple-400'
                : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-purple-500/30 hover:text-purple-400'
            }`}
          >
            <Paintbrush className="w-3.5 h-3.5" />
            {t('workflow.repaint', 'Repaint')}
          </button>
          <button
            onClick={() => handleWorkflowMode('extend')}
            className={`flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
              params.taskType === 'complete'
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-emerald-500/30 hover:text-emerald-400'
            }`}
          >
            <ListMusic className="w-3.5 h-3.5" />
            {t('workflow.extend', 'Extend')}
          </button>
        </div>
        )}

        {/* Audio Sections — hidden when the audio-input switch is off */}
        {params.customMode && !params.ignoreAudioInput && (
          <AudioSections
            referenceAudioUrl={params.referenceAudioUrl}
            referenceAudioTitle={params.referenceAudioTitle}
            onReferenceUpload={f => handleAudioSectionUpload(f, 'reference')}
            onReferenceClear={() => { set('referenceAudioUrl', undefined); set('referenceAudioTitle', undefined); }}
            onReferenceSongDrop={(url, title) => { addToAudioHistory(url, title); set('referenceAudioUrl', url); set('referenceAudioTitle', title); }}
            coverAudioUrl={params.sourceAudioUrl}
            coverAudioTitle={params.sourceAudioTitle}
            onCoverUpload={f => handleAudioSectionUpload(f, 'source')}
            onCoverClear={() => { set('sourceAudioUrl', undefined); set('sourceAudioTitle', undefined); set('taskType', undefined); }}
            onCoverSongDrop={(url, title) => { addToAudioHistory(url, title); set('sourceAudioUrl', url); set('sourceAudioTitle', title); set('taskType', 'cover'); }}
            vocalAudioUrl={params.vocalAudioUrl}
            vocalAudioTitle={params.vocalAudioTitle}
            onVocalUpload={f => handleAudioSectionUpload(f, 'vocal')}
            onVocalClear={() => { set('vocalAudioUrl', undefined); set('vocalAudioTitle', undefined); }}
            onVocalSongDrop={(url, title) => { addToAudioHistory(url, title); set('vocalAudioUrl', url); set('vocalAudioTitle', title); }}
            onExtendUpload={f => { handleAudioSectionUpload(f, 'source'); set('taskType', 'complete'); }}
            onExtendClear={() => { set('sourceAudioUrl', undefined); set('sourceAudioTitle', undefined); set('taskType', undefined); }}
            onExtendSongDrop={(url, title) => { addToAudioHistory(url, title); set('sourceAudioUrl', url); set('sourceAudioTitle', title); set('taskType', 'complete'); }}
            onRecord={() => { setMicTarget('vocal'); setShowMicRecorder(true); }}
            activeTab={audioTab}
            onActiveTabChange={setAudioTab}
            taskType={params.taskType}
            audioCoverStrength={params.audioCoverStrength ?? 0.5}
            onAudioCoverStrengthChange={v => set('audioCoverStrength', v)}
            referenceStrength={params.referenceStrength ?? 1.0}
            onReferenceStrengthChange={v => set('referenceStrength', v)}
            repaintingStart={params.repaintingStart ?? 0}
            repaintingEnd={params.repaintingEnd ?? 1}
            onRepaintingChange={(s, e) => { set('repaintingStart', s); set('repaintingEnd', e); }}
            audioHistory={audioHistory}
            onHistorySelect={handleHistorySelect}
          />
        )}

        {/* Simple mode */}
        {!params.customMode && (
          <div className="space-y-3">
            <div className="relative">
              <SnippetMenu
                title={t('create.savedPrompts', 'Saved prompts')}
                snippets={snippets.prompts}
                currentValue={params.songDescription || ''}
                onSave={(n, v) => saveSnippet('prompts', n, v)}
                onDelete={n => deleteSnippet('prompts', n)}
                onApply={v => set('songDescription', v)}
                className="absolute top-1 right-1 z-20"
              />
              <textarea
                value={params.songDescription || ''}
                onChange={e => set('songDescription', e.target.value)}
                placeholder={t('create.descriptionPlaceholder')}
                rows={4}
                ref={el => { (simpleTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el; }}
                className="w-full bg-surface-100 border border-surface-300 rounded-lg px-3 py-2 text-sm text-surface-900 placeholder:text-surface-400 min-h-[80px] max-h-[400px] no-scrollbar focus:ring-1 focus:ring-accent-500"
              />
              <div
                className="textarea-resize-handle"
                onMouseDown={e => {
                  e.preventDefault();
                  const textarea = simpleTextareaRef.current;
                  if (!textarea) return;
                  const startY = e.clientY;
                  const startH = textarea.offsetHeight;
                  const onMove = (ev: MouseEvent) => {
                    const newH = Math.max(80, Math.min(400, startH + ev.clientY - startY));
                    textarea.style.height = `${newH}px`;
                  };
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                  };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              />
            </div>
            <ToggleField
              label={t('create.instrumental')}
              value={params.instrumental}
              onChange={v => set('instrumental', v)}
            />
          </div>
        )}

        {/* Advanced mode */}
        {params.customMode && (
          <div className="space-y-2">
            {/* Text & Style */}
            <CollapsibleSection
              title={t('create.sections.text')}
              isOpen={openSections.text}
              onToggle={() => toggleSection('text')}
            >
              <input
                type="text"
                value={params.title}
                onChange={e => set('title', e.target.value)}
                placeholder={t('create.titlePlaceholder')}
                className="w-full bg-surface-100 border border-surface-300 rounded-md px-2 py-1.5 text-sm text-surface-900 placeholder:text-surface-400"
              />
              <div className="relative">
                <SnippetMenu
                  title={t('create.savedStyles', 'Saved styles')}
                  snippets={snippets.styles}
                  currentValue={params.style || ''}
                  onSave={(n, v) => saveSnippet('styles', n, v)}
                  onDelete={n => deleteSnippet('styles', n)}
                  onApply={v => set('style', v)}
                  className="absolute top-1 right-1 z-20"
                />
                <textarea
                  value={params.style}
                  onChange={e => set('style', e.target.value)}
                  placeholder={t('create.stylePlaceholder')}
                  rows={2}
                  ref={styleTextareaRef}
                  className="w-full bg-surface-100 border border-surface-300 rounded-md px-2 py-1.5 text-sm text-surface-900 placeholder:text-surface-400 resize-none min-h-[40px] max-h-[200px]"
                />
                <div
                  className="textarea-resize-handle"
                  onMouseDown={e => {
                    e.preventDefault();
                    const textarea = styleTextareaRef.current;
                    if (!textarea) return;
                    const startY = e.clientY;
                    const startH = textarea.offsetHeight;
                    const onMove = (ev: MouseEvent) => {
                      const newH = Math.max(40, Math.min(200, startH + ev.clientY - startY));
                      textarea.style.height = `${newH}px`;
                    };
                    const onUp = () => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                />
              </div>
              {/* Lyrics with colored overlay */}
              <div className="relative" ref={lyricsContainerRef}>
                {/* Saved lyrics */}
                <SnippetMenu
                  title={t('create.savedLyrics', 'Saved lyrics')}
                  snippets={snippets.lyrics}
                  currentValue={params.lyrics || ''}
                  onSave={(n, v) => saveSnippet('lyrics', n, v)}
                  onDelete={n => deleteSnippet('lyrics', n)}
                  onApply={v => set('lyrics', v)}
                  className="absolute top-1 right-7 z-20"
                />
                {/* Color toggle button */}
                <button
                  onClick={() => setColoredLyrics(v => !v)}
                  className={`absolute top-1 right-1 z-20 p-1 rounded transition-colors pointer-events-auto ${
                    coloredLyrics
                      ? 'text-accent-400 bg-accent-500/15 hover:bg-accent-500/25'
                      : 'text-surface-500 hover:text-surface-700 hover:bg-surface-200'
                  }`}
                  title={t('create.toggleColors', 'Toggle section colors')}
                >
                  <Palette className="w-3.5 h-3.5" />
                </button>
                {/* Section-tag autocomplete — appears while typing '[' */}
                {tagQuery !== null && !params.instrumental && (() => {
                  const q = tagQuery.trim().toLowerCase();
                  const matches = SECTION_TAGS.filter(s => s.tag.slice(1).toLowerCase().startsWith(q));
                  if (matches.length === 0) return null;
                  return (
                    <div className="absolute left-2 top-9 z-30 w-44 bg-surface-100 border border-surface-300 rounded-lg shadow-2xl overflow-hidden">
                      <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-surface-400 border-b border-surface-200">{t('create.sectionTags', 'Section tags')}</div>
                      {matches.map(s => (
                        <button
                          key={s.tag}
                          type="button"
                          onMouseDown={ev => {
                            ev.preventDefault();
                            const ta = lyricsRef.current;
                            if (!ta) return;
                            const value = params.lyrics || '';
                            const pos = ta.selectionStart;
                            const beforeTxt = value.slice(0, pos).replace(/\[[a-zA-Z -]*$/, s.tag);
                            const newValue = beforeTxt + value.slice(pos);
                            set('lyrics', newValue);
                            setTagQuery(null);
                            requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = beforeTxt.length; ta.focus(); });
                          }}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-surface-200 text-left transition-colors"
                        >
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.hex }} />
                          <span className={`font-mono ${s.color}`}>{s.tag}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
                <textarea
                  value={params.lyrics}
                  onChange={e => {
                    const v = e.target.value;
                    set('lyrics', v);
                    // Section-tag autocomplete: detect an open '[' + partial word before the cursor.
                    const before = v.slice(0, e.target.selectionStart);
                    const m = before.match(/\[([a-zA-Z -]*)$/);
                    setTagQuery(m ? m[1] : null);
                  }}
                  onKeyDown={e => { if (e.key === 'Escape') setTagQuery(null); }}
                  onBlur={() => window.setTimeout(() => setTagQuery(null), 150)}
                  onScroll={e => {
                    if (overlayRef.current) {
                      overlayRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                    }
                  }}
                  placeholder={params.instrumental ? t('create.instrumentalNoLyrics', 'Instrumental mode — lyrics disabled') : t('create.lyricsPlaceholder')}
                  rows={6}
                  ref={lyricsRef}
                  disabled={params.instrumental}
                  style={coloredLyrics && params.lyrics && !params.instrumental ? { lineHeight: '1.5', color: 'transparent', caretColor: 'var(--color-surface-900)' } : { lineHeight: '1.5' }}
                  className={`relative w-full bg-surface-100 border border-surface-300 rounded-md px-2 py-1.5 text-surface-900 placeholder:text-surface-400 min-h-[100px] max-h-[800px] font-mono text-xs no-scrollbar ${
                    params.instrumental ? 'opacity-40 cursor-not-allowed' : ''
                  }`}
                />
                {/* Colored overlay — sits ABOVE textarea text, pointer-events-none */}
                {coloredLyrics && params.lyrics && !params.instrumental && (
                  <div
                    ref={overlayRef}
                    className="absolute top-0 left-0 right-0 bottom-0 pointer-events-none overflow-hidden rounded-md z-10"
                  >
                    <div
                      className="px-2 py-1.5 font-mono text-xs"
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5' }}
                    >
                      {renderColoredLyrics(params.lyrics)}
                    </div>
                  </div>
                )}
                {/* Bottom resize handle */}
                <div
                  className="textarea-resize-handle"
                  onMouseDown={e => {
                    e.preventDefault();
                    const textarea = lyricsRef.current;
                    if (!textarea) return;
                    const startY = e.clientY;
                    const startH = textarea.offsetHeight;
                    const onMove = (ev: MouseEvent) => {
                      const newH = Math.max(100, Math.min(800, startH + ev.clientY - startY));
                      textarea.style.height = `${newH}px`;
                    };
                    const onUp = () => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                />
              </div>
              <ToggleField
                label={t('create.instrumental')}
                value={params.instrumental}
                onChange={v => set('instrumental', v)}
              />
              {/* Section Controls */}
              <SectionControls
                sectionMode={params.sectionMode ?? false}
                onSectionModeChange={v => set('sectionMode', v)}
                sectionMeasures={params.sectionMeasures ?? 8}
                onSectionMeasuresChange={v => set('sectionMeasures', v)}
                alignToMeasures={params.alignToMeasures ?? false}
                onAlignToMeasuresChange={v => set('alignToMeasures', v)}
                onInsertTag={params.instrumental ? undefined : handleInsertSectionTag}
              />
            </CollapsibleSection>

            {/* Musical Parameters */}
            <CollapsibleSection
              title={t('create.sections.music')}
              isOpen={openSections.music}
              onToggle={() => toggleSection('music')}
              badge={params.bpm ? `${params.bpm} BPM` : t('create.bpmAutoBadge', 'BPM Auto')}
            >
              <div className="space-y-1">
                <div className="flex items-end gap-2">
                  <div className="flex-1 min-w-0">
                    <SliderField label={t('create.bpm')} value={params.bpm === 0 ? (lastManualBpmRef.current || 120) : params.bpm} onChange={v => set('bpm', v)} min={30} max={300} disabled={params.bpm === 0} tooltip={t('tooltip.bpm')} />
                  </div>
                  <button
                    onClick={toggleAutoBpm}
                    className={`px-2 py-1 mb-0.5 rounded-md text-[10px] font-semibold border transition-colors shrink-0 ${
                      params.bpm === 0
                        ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                        : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/40 hover:text-accent-400'
                    }`}
                    title={t('create.bpmAutoTooltip', 'Auto: the model detects the tempo from the style and any reference/cover audio')}
                  >
                    {t('create.bpmAuto', 'Auto')}
                  </button>
                </div>
                {params.bpm === 0 && (
                  <p className="text-[10px] text-accent-400 ml-1">{t('create.bpmAutoHint', 'Auto: tempo detected from the style / reference audio')}</p>
                )}
              </div>
              <div className="space-y-1">
                <SliderField label={t('create.duration')} value={params.duration} onChange={v => set('duration', v)} min={0} max={600} suffix={params.duration === 0 ? 'Auto' : t('create.seconds')} tooltip={t('tooltip.duration')} />
                {params.duration === 0 && (
                  <p className="text-[10px] text-accent-400 ml-1">{t('create.durationAuto', 'Auto: duration based on lyrics & structure')}</p>
                )}
              </div>
              <SelectField label={t('create.key')} value={params.keyScale} onChange={v => set('keyScale', v)} options={keyOptions} tooltip={t('tooltip.key')} />
              <SelectField label={t('create.timeSignature')} value={params.timeSignature} onChange={v => set('timeSignature', v)} options={tsOptions} tooltip={t('tooltip.timeSignature')} />
              {/* Chord Progression — open in modal */}
              <div className="pt-1">
                <button
                  onClick={() => setShowChordModal(true)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl
                    bg-surface-100 border border-surface-300 hover:border-accent-500/40
                    hover:bg-accent-500/5 transition-all group"
                >
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-600/20 to-brand-500/20
                    flex items-center justify-center shrink-0">
                    <Piano className="w-4 h-4 text-accent-400" />
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-xs font-semibold text-surface-800 group-hover:text-accent-400 transition-colors">
                      {t('chords.composerTitle', 'Chord Progression Composer')}
                    </p>
                    <p className="text-[10px] text-surface-500 font-mono truncate">
                      {chordState.roman || t('chords.noProgression', 'No progression set')}
                    </p>
                  </div>
                  <span className="text-[10px] text-surface-400 shrink-0">
                    {chordState.key} {chordState.scale === 'major' ? 'Maj' : 'Min'}
                  </span>
                </button>
              </div>

              {/* Chord Modal */}
              {showChordModal && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                  onClick={() => setShowChordModal(false)}
                >
                  <div
                    className="bg-surface-50 rounded-2xl shadow-2xl border border-surface-300
                      w-[580px] max-w-[95vw] max-h-[90vh] overflow-y-auto"
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between px-5 py-3 border-b border-surface-200 sticky top-0 bg-surface-50 z-10">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-600 to-brand-500
                          flex items-center justify-center">
                          <Piano className="w-4 h-4 text-white" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-surface-900">
                            {t('chords.composerTitle', 'Chord Progression Composer')}
                          </h3>
                          <p className="text-[10px] text-surface-400">
                            {t('chords.composerHint', 'Affects the latent audio generation model')}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowChordModal(false)}
                        className="p-1.5 rounded-lg hover:bg-surface-200 text-surface-400 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="p-5">
                      <ChordEditor
                        value={chordState}
                        onChange={setChordState}
                        onApply={async (data) => {
                          await handleChordApply(data);
                          setShowChordModal(false);
                        }}
                      />
                      {chordApplyLoading && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-accent-400">
                          <div className="w-3 h-3 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
                          {chordApplyLoading}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CollapsibleSection>

            {/* Voice & Language */}
            <CollapsibleSection
              title={t('create.sections.voice')}
              isOpen={openSections.voice}
              onToggle={() => toggleSection('voice')}
            >
              <SelectField label={t('common.language')} value={params.vocalLanguage} onChange={v => set('vocalLanguage', v)} options={vocalOptions} />
              {!params.instrumental && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-surface-500 w-24 shrink-0">{t('create.singer', 'Voice')}</label>
                  <div className="flex gap-1 flex-1">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'male', label: t('create.singerMale', 'Male') },
                      { value: 'female', label: t('create.singerFemale', 'Female') },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => set('singer', opt.value as '' | 'male' | 'female')}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          params.singer === opt.value
                            ? 'bg-accent-500/20 text-accent-400 border-accent-500/30'
                            : 'bg-surface-100 text-surface-500 border-surface-300 hover:bg-surface-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => { setMicTarget('vocal'); setShowMicRecorder(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
              >
                <Mic className="w-3.5 h-3.5" />
                {t('create.recordVoice', 'Record Voice')}
              </button>
            </CollapsibleSection>

            {/* Style DNA */}
            <StyleDnaPanel
              dna={styleDna}
              onChange={setStyleDna}
              isOpen={openSections.styleDna ?? false}
              onToggle={() => toggleSection('styleDna')}
              lyrics={params.lyrics}
              tagCadences={tagCadences}
              onTagCadencesChange={setTagCadences}
            />

            {/* LoRA */}
            <CollapsibleSection
              title="LoRA"
              isOpen={openSections.lora ?? false}
              onToggle={() => toggleSection('lora')}
              badge={loraLoaded ? (loraEnabled ? 'Active' : 'Off') : undefined}
            >
              <div className="space-y-2">
                {loraLoaded ? (
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${loraEnabled ? 'bg-green-500' : 'bg-surface-400'}`} />
                    <span className="text-xs text-surface-700 truncate flex-1">{selectedLoraName}</span>
                    <span className="text-[10px] text-surface-400 font-mono">{loraScale.toFixed(1)}x</span>
                  </div>
                ) : (
                  <p className="text-xs text-surface-400">{t('lora.noLoaded', 'No LoRA loaded')}</p>
                )}
                {loraWarning && (
                  <div className="px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <span className="text-[10px] text-amber-400 leading-snug">{loraWarning}</span>
                  </div>
                )}
                <button
                  onClick={() => setShowLoraManager(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                    bg-brand-500/10 text-brand-400 border border-brand-500/20 hover:bg-brand-500/20 transition-colors w-full justify-center"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  {t('lora.openManager', 'Open LoRA Manager')}
                </button>
              </div>
            </CollapsibleSection>

            {/* Generation Settings */}
            <CollapsibleSection
              title={t('create.sections.generation')}
              isOpen={openSections.generation}
              onToggle={() => toggleSection('generation')}
            >
              <SliderField
                label={t('create.steps')}
                value={timestepsCheck?.ok ? timestepsCheck.steps : params.inferenceSteps}
                onChange={v => set('inferenceSteps', v)}
                min={10}
                max={200}
                disabled={!!timestepsCheck?.ok}
                tooltip={timestepsCheck?.ok
                  ? t('tooltip.stepsOverridden', 'Overridden by Custom Timesteps: the schedule length defines the real step count.')
                  : t('tooltip.steps')}
              />
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <SliderField label={t('create.guidance')} value={params.guidanceScale} onChange={v => set('guidanceScale', v)} min={1} max={30} step={0.5} tooltip={t('tooltip.guidance')} />
                </div>
                <button
                  onClick={() => setPinGuidance(v => {
                    const n = !v;
                    try {
                      localStorage.setItem('prodia_pin_guidance', String(n));
                      if (!n) localStorage.removeItem('prodia_guidance_value');
                    } catch { /* ignore */ }
                    return n;
                  })}
                  className={`p-1 rounded-md transition-colors shrink-0 ${pinGuidance ? 'text-accent-400 bg-accent-500/10' : 'text-surface-400 hover:text-accent-400 hover:bg-surface-200'}`}
                  title={pinGuidance ? t('create.unpinGuidance', 'Guidance value is remembered — click to use the default on next restart') : t('create.pinGuidance', 'Remember this guidance value next time you open the app')}
                >
                  {pinGuidance ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
              <SliderField label={t('create.batch')} value={params.batchSize} onChange={v => set('batchSize', v)} min={1} max={8} tooltip={t('tooltip.batch')} />
              <SliderField label={t('create.shift')} value={params.shift} onChange={v => set('shift', v)} min={0} max={10} step={0.5} tooltip={t('tooltip.shift')} />
              <div className="flex items-center gap-3">
                <label className="text-xs text-surface-500 w-24">{t('create.seed')}</label>
                <div className="flex-1 flex items-center gap-2">
                  <ToggleField label={t('create.randomSeed')} value={params.randomSeed} onChange={v => set('randomSeed', v)} />
                  {!params.randomSeed && (
                    <div className="flex items-center gap-1">
                      {/* −/+ step the seed by 1 to explore manual variations of a good seed */}
                      <button
                        type="button"
                        onClick={() => set('seed', Math.max(0, (Number(params.seed) || 0) - 1))}
                        title={t('create.seedPrev', 'Variación anterior (−1)')}
                        className="w-6 h-6 flex items-center justify-center rounded bg-surface-200 text-surface-500 hover:text-accent-400 hover:bg-surface-300 transition-colors shrink-0"
                      >−</button>
                      <input
                        type="number"
                        value={params.seed}
                        onChange={e => set('seed', parseInt(e.target.value) || 0)}
                        className="w-24 bg-surface-100 border border-surface-300 rounded px-2 py-1 text-xs text-surface-900 text-center tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={() => set('seed', (Number(params.seed) || 0) + 1)}
                        title={t('create.seedNext', 'Siguiente variación (+1)')}
                        className="w-6 h-6 flex items-center justify-center rounded bg-surface-200 text-surface-500 hover:text-accent-400 hover:bg-surface-300 transition-colors shrink-0"
                      >+</button>
                      <button
                        type="button"
                        onClick={() => set('seed', Math.floor(Math.random() * 4294967295) + 1)}
                        title={t('create.seedRandom', 'Tirar una semilla aleatoria al campo')}
                        className="w-6 h-6 flex items-center justify-center rounded bg-surface-200 text-surface-500 hover:text-accent-400 hover:bg-surface-300 transition-colors shrink-0"
                      >
                        <Dice5 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <ToggleField label={t('create.thinking')} value={params.thinking} onChange={v => set('thinking', v)} tooltip={t('tooltip.thinking')} />
              <div className="flex gap-3">
                <SelectField label={t('create.format')} value={params.audioFormat} onChange={v => set('audioFormat', v as 'mp3' | 'flac' | 'wav')} options={[{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }, { value: 'flac', label: 'FLAC' }]} />
                <SelectField label={t('create.method')} value={params.inferMethod} onChange={v => set('inferMethod', v as 'ode' | 'sde')} options={[{ value: 'ode', label: 'ODE' }, { value: 'sde', label: 'SDE' }]} />
              </div>
            </CollapsibleSection>

            {/* LM Parameters */}
            <CollapsibleSection
              title={t('create.sections.lm')}
              isOpen={openSections.lm}
              onToggle={() => toggleSection('lm')}
              badge={currentLmModel ? LM_SIZES.find(s => currentLmModel.includes(s.label))?.label : undefined}
            >
              {/* LM Model Size selector */}
              <div className="space-y-1.5">
                <label className="text-xs text-surface-500 font-medium">{t('create.lmModelLabel', 'LM Model')}</label>
                <div className="flex gap-1.5">
                  {LM_SIZES.map(s => {
                    const isActive = currentLmModel?.includes(s.label);
                    return (
                      <button
                        key={s.value}
                        disabled={lmSwapping}
                        onClick={() => handleSwapLm(s.value, params.lmBackend || 'pt', !!isActive)}
                        title={isActive ? t('create.lmUnloadHint', 'Loaded — click to unload from memory') : `${s.label} · ${s.vram}`}
                        className={`flex-1 flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                          isActive
                            ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                            : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/30 hover:text-surface-700'
                        } ${lmSwapping ? 'opacity-50' : ''}`}
                      >
                        <span className="font-bold">{s.label}</span>
                        <span className="text-[9px] opacity-70">{s.vram}</span>
                        {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
                      </button>
                    );
                  })}
                </div>
                {lmSwapping && (
                  <div className="flex items-center gap-1.5 text-[10px] text-accent-400">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    {t('create.lmSwapping', 'Loading model...')}
                  </div>
                )}
                <p className="text-[10px] text-surface-400">{t('create.lmModelHint', 'Auto-downloads if not present. Larger = better quality, more VRAM.')}</p>
              </div>
              {/* LM Backend toggle */}
              <div className="space-y-1">
                <label className="text-xs text-surface-500 font-medium">{t('create.lmBackendLabel', 'LM Backend')}</label>
                <div className="flex gap-1.5">
                  {(['pt', 'vllm'] as const).map(b => {
                    const isActive = (params.lmBackend || currentLmBackend || 'pt') === b;
                    return (
                      <button
                        key={b}
                        onClick={() => set('lmBackend', b)}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          isActive
                            ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                            : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/30'
                        }`}
                      >
                        {b === 'pt' ? 'PyTorch' : 'vLLM'}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-surface-400">{t('create.lmBackendHint', 'PT uses less VRAM, vLLM may be faster on powerful GPUs.')}</p>
              </div>
              <SliderField label={t('create.temperature')} value={params.lmTemperature} onChange={v => set('lmTemperature', v)} min={0} max={2} step={0.05} tooltip={t('tooltip.lmTemperature')} />
              <SliderField label={t('create.cfgScale')} value={params.lmCfgScale} onChange={v => set('lmCfgScale', v)} min={0} max={5} step={0.1} tooltip={t('tooltip.lmCfgScale')} />
              <SliderField label={t('create.topK')} value={params.lmTopK} onChange={v => set('lmTopK', v)} min={1} max={500} tooltip={t('tooltip.topK')} />
              <SliderField label={t('create.topP')} value={params.lmTopP} onChange={v => set('lmTopP', v)} min={0} max={1} step={0.01} tooltip={t('tooltip.topP')} />
              <SliderField label={t('create.repetitionPenalty', 'Repetition Penalty')} value={params.lmRepetitionPenalty ?? 1.2} onChange={v => set('lmRepetitionPenalty', v)} min={1} max={2} step={0.05} tooltip={t('tooltip.repetitionPenalty', 'Higher = less repetition of words/sounds. Raise to 1.3-1.5 if it repeats a word until it breaks.')} />
              <SliderField label={t('create.noRepeatNgram', 'No-Repeat N-gram')} value={params.noRepeatNgramSize ?? 0} onChange={v => set('noRepeatNgramSize', v)} min={0} max={8} step={1} tooltip={t('tooltip.noRepeatNgram', 'Blocks repeating the same group of N tokens (0 = off). Try 2-3 to stop stuck repetitions.')} />
              <div className="flex items-center gap-3">
                <label className="text-xs text-surface-500 w-24">{t('create.negativePrompt')}</label>
                <input
                  type="text"
                  value={params.lmNegativePrompt}
                  onChange={e => set('lmNegativePrompt', e.target.value)}
                  className="flex-1 bg-surface-100 border border-surface-300 rounded px-2 py-1 text-xs text-surface-900"
                  placeholder="e.g. noise, distortion..."
                />
              </div>
            </CollapsibleSection>

            {/* Experimental Lab — individually toggleable, genuinely model-interpreted controls */}
            <CollapsibleSection
              title={t('create.sections.experimental', 'Experimental Lab')}
              isOpen={openSections.experimental}
              onToggle={() => toggleSection('experimental')}
              badge={(params.captionBoosters?.length || 0) > 0 ? `${params.captionBoosters!.length} ✦` : undefined}
            >
              {/* Generation pipeline mode */}
              <div className="space-y-1.5">
                <label className="text-xs text-surface-500 font-medium">{t('create.genMode', 'Generation Mode')}</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {GENERATION_MODES.map(m => {
                    const active = generationMode === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setParams(p => ({ ...p, ...m.apply }))}
                        title={t(`create.genMode_${m.id}Desc`, m.desc)}
                        className={`px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                          active
                            ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                            : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/30 hover:text-surface-700'
                        }`}
                      >
                        {t(`create.genMode_${m.id}`, m.label)}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-surface-400">
                  {t(`create.genMode_${generationMode}Desc`, GENERATION_MODES.find(m => m.id === generationMode)!.desc)}
                </p>
              </div>

              {/* Consistency macro — one slider driving the LM sampling + DiT guidance knobs */}
              <div className="space-y-1">
                <SliderField
                  label={t('create.consistency', 'Consistency')}
                  value={consistency}
                  onChange={applyConsistency}
                  min={0}
                  max={100}
                  step={5}
                  suffix={consistency <= 25 ? t('create.consistencyWild', 'Wild') : consistency >= 75 ? t('create.consistencyLocked', 'Locked') : t('create.consistencyBalanced', 'Balanced')}
                  tooltip={t('tooltip.consistency', 'Macro control. Left = exploratory (hot LM sampling, loose guidance, motifs may wander). Right = locked (cold sampling, n-gram loop blocking, tight guidance — melodies stay on-key and on-theme). Moving it overwrites LM Temperature/Top-P/Top-K/Repetition/N-gram/CFG and DiT Guidance.')}
                />
                <p className="text-[10px] text-surface-400">{t('create.consistencyHint', 'Sets 7 knobs the model really reads (LM sampling + DiT guidance). Fine-tune them afterwards in the LM / Generation sections.')}</p>
              </div>

              {/* Caption boosters — toggleable tag packs conditioned by the LM */}
              <div className="space-y-1.5">
                <label className="text-xs text-surface-500 font-medium">{t('create.boostersLabel', 'Caption Boosters')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {CAPTION_BOOSTERS.map(b => {
                    const active = (params.captionBoosters || []).includes(b.id);
                    return (
                      <button
                        key={b.id}
                        onClick={() => toggleBooster(b.id)}
                        title={b.tags}
                        className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                          active
                            ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                            : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/30 hover:text-surface-700'
                        }`}
                      >
                        {b.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-surface-400">{t('create.boostersHint', 'Each chip appends caption vocabulary the model was trained on. Toggle individually to A/B test production, era and mix character.')}</p>
              </div>

              {/* Chain-of-Thought controls — only interpreted when Thinking is ON */}
              <div className={`space-y-2 ${params.thinking ? '' : 'opacity-50 pointer-events-none'}`}>
                <ToggleField
                  label={t('create.cotMetas', 'CoT Metas (auto BPM/key/duration)')}
                  value={params.useCotMetas ?? true}
                  onChange={v => set('useCotMetas', v)}
                  tooltip={t('tooltip.cotMetas', 'ON: the LM infers BPM, key and structure itself. OFF: your manual values dominate — better consistency between takes.')}
                />
                <ToggleField
                  label={t('create.cotCaption', 'Caption Rewrite')}
                  value={params.useCotCaption ?? true}
                  onChange={v => set('useCotCaption', v)}
                  tooltip={t('tooltip.cotCaption', 'ON: the LM rewrites/enriches your style text (more variety). OFF: your exact caption is used — maximum reproducibility.')}
                />
                <ToggleField
                  label={t('create.cotLanguage', 'CoT Language Detection')}
                  value={params.useCotLanguage ?? true}
                  onChange={v => set('useCotLanguage', v)}
                  tooltip={t('tooltip.cotLanguage', 'ON: the LM infers the vocal language. OFF: rely on your Vocal Language setting only.')}
                />
              </div>
              {!params.thinking && (
                <p className="text-[10px] text-amber-500/80">{t('create.cotNeedsThinking', 'CoT toggles require "Thinking" (Generation Settings) to be ON.')}</p>
              )}

              <ToggleField
                label={t('create.parallelThinking', 'Parallel Thinking (LM batch)')}
                value={params.allowLmBatch ?? true}
                onChange={v => set('allowLmBatch', v)}
                tooltip={t('tooltip.parallelThinking', 'Batches LM decoding for multi-variation generations. Turn OFF to isolate variations completely when experimenting.')}
              />

              {/* LM instruction override */}
              <div className="space-y-1">
                <label className="text-xs text-surface-500 font-medium">{t('create.instructionOverride', 'LM Instruction Override')}</label>
                <input
                  type="text"
                  value={params.instruction || ''}
                  onChange={e => set('instruction', e.target.value || undefined)}
                  className="w-full bg-surface-100 border border-surface-300 rounded px-2 py-1 text-xs text-surface-900"
                  placeholder={t('create.instructionPlaceholder', '(default) Fill the audio semantic mask with the style described in the text prompt.')}
                />
                <p className="text-[10px] text-surface-400">{t('create.instructionHint', 'The task instruction the LM reads before composing. Leave empty for the default. Powerful for steering global behavior.')}</p>
              </div>

              {/* Custom sampling timesteps */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-surface-500 font-medium">{t('create.customTimesteps', 'Custom Timesteps (DiT)')}</label>
                  {timestepsCheck?.ok && (
                    <span className="text-[10px] text-green-500">{t('create.timestepsSteps', '{{n}} steps', { n: timestepsCheck.steps })}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {TIMESTEP_SHAPES.map(s => {
                    const active = !!timestepsCheck?.ok && tsShape === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => applyTimestepShape(s.id, tsSteps)}
                        className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                          active
                            ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
                            : 'bg-surface-100 border-surface-300/40 text-surface-500 hover:border-accent-500/30'
                        }`}
                      >
                        {t(`create.tsShape_${s.id}`, s.label)}
                      </button>
                    );
                  })}
                  <span className="text-[10px] text-surface-400 ml-1">×</span>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={tsSteps}
                    onChange={e => setTsSteps(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
                    onBlur={() => { if (timestepsCheck?.ok) applyTimestepShape(tsShape, tsSteps); }}
                    className="w-14 bg-surface-100 border border-surface-300 rounded px-1.5 py-0.5 text-[10px] text-surface-900 font-mono"
                    title={t('create.tsStepsTitle', 'Number of steps for the generated schedule')}
                  />
                  <span className="text-[10px] text-surface-400">{t('create.tsStepsUnit', 'steps')}</span>
                  {params.customTimesteps && (
                    <button
                      onClick={() => set('customTimesteps', undefined)}
                      className="ml-auto px-1.5 py-0.5 rounded text-[10px] text-surface-500 hover:text-red-400 transition-colors"
                    >
                      {t('create.tsClear', 'Clear')}
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={params.customTimesteps || ''}
                  onChange={e => set('customTimesteps', e.target.value || undefined)}
                  className={`w-full bg-surface-100 border rounded px-2 py-1 text-xs text-surface-900 font-mono ${
                    timestepsCheck && !timestepsCheck.ok ? 'border-red-500/70' : 'border-surface-300'
                  }`}
                  placeholder="e.g. 1.0, 0.76, 0.5, 0.28, 0"
                />
                {timestepsCheck && !timestepsCheck.ok && (
                  <p className="text-[10px] text-red-400">
                    {timestepsCheck.error === 'range' && t('create.tsErrRange', 'Values must be within 0.0–1.0 — the backend will DROP the whole list and use the auto schedule.')}
                    {timestepsCheck.error === 'order' && t('create.tsErrOrder', 'Values must be strictly descending (1.0 → 0). A rising step pushes the latent backwards and corrupts the audio.')}
                    {timestepsCheck.error === 'format' && t('create.tsErrFormat', 'Only comma-separated numbers are allowed.')}
                  </p>
                )}
                {timestepsCheck?.ok && params.inferMethod === 'sde' && (
                  <p className="text-[10px] text-amber-500/80">{t('create.tsSdeWarn', 'SDE ignores custom values (only the step count is used). Switch to ODE for the schedule to take effect.')}</p>
                )}
                {timestepsCheck?.ok && timestepsUnsupported && (
                  <p className="text-[10px] text-amber-500/80">{t('create.tsBaseWarn', 'The non-XL Base checkpoint ignores custom timesteps entirely. Use SFT, Turbo or any XL model.')}</p>
                )}
                <p className="text-[10px] text-surface-400">{t('create.customTimestepsHint', 'Redistributes WHERE your steps are spent — it does not add quality by itself. Big effect at 8-20 steps (Turbo); at 50-100 the grid is already dense so gains are subtle. Structure = pack steps near noise (form, rhythm); Detail = near the end (texture, air). Empty = auto.')}</p>
              </div>
            </CollapsibleSection>

            {/* Expert */}
            <CollapsibleSection
              title={t('create.sections.expert')}
              isOpen={openSections.expert}
              onToggle={() => toggleSection('expert')}
            >
              <SelectField label={t('create.taskType')} value={params.taskType || ''} onChange={v => set('taskType', v || undefined)} options={taskOptions} />
              <SliderField label={t('create.repaintStart')} value={params.repaintingStart ?? 0} onChange={v => set('repaintingStart', v)} min={0} max={1} step={0.05} tooltip={t('tooltip.repaintStart')} />
              <SliderField label={t('create.repaintEnd')} value={params.repaintingEnd ?? 1} onChange={v => set('repaintingEnd', v)} min={0} max={1} step={0.05} tooltip={t('tooltip.repaintEnd')} />
              <ToggleField label="ADG" value={params.useAdg ?? false} onChange={v => set('useAdg', v)} />
              {(params.sourceAudioUrl || params.taskType === 'cover') && (
                <SliderField label={t('create.coverStrength')} value={params.audioCoverStrength ?? 0.5} onChange={v => set('audioCoverStrength', v)} min={0} max={1} step={0.05} />
              )}
            </CollapsibleSection>
          </div>
        )}
      </div>

      {/* Generate button - sticky at bottom */}
      <div className="px-4 py-3 border-t border-surface-300/60 bg-surface-50 space-y-2">
        <InfoPanel />
        <GpuMiniBar
          isGenerating={isGenerating}
          progress={generationProgress}
          stage={generationStage}
        />
        <QuickParamsPanel
          values={{
            lmRepetitionPenalty: params.lmRepetitionPenalty,
            noRepeatNgramSize: params.noRepeatNgramSize,
            melodicVariation: params.melodicVariation,
            lmTemperature: params.lmTemperature,
            lmCfgScale: params.lmCfgScale,
            lmTopK: params.lmTopK,
            lmTopP: params.lmTopP,
            guidanceScale: params.guidanceScale,
            inferenceSteps: params.inferenceSteps,
            shift: params.shift,
            apgNormThreshold: params.apgNormThreshold,
            apgMomentum: params.apgMomentum,
            apgEta: params.apgEta,
          }}
          onChange={(key, value) => set(key as keyof typeof params, value as any)}
        />
        {/* Active style-reference chip — visible whenever a reference song is set,
            so it's obvious and easy to remove (the Reference tab lives inside Audio). */}
        {params.referenceAudioUrl && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-accent-500/10 border border-accent-500/30">
            <Disc3 className="w-4 h-4 text-accent-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-surface-400 leading-none">{t('audio.referenceActive', 'Style reference')}</div>
              <div className="text-xs font-medium text-accent-300 truncate">{params.referenceAudioTitle || t('audio.reference', 'Reference')}</div>
            </div>
            <button
              onClick={() => { set('referenceAudioUrl', undefined); set('referenceAudioTitle', undefined); }}
              className="p-1 rounded text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
              title={t('audio.removeReference', 'Remove reference')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <button
          onClick={handleGenerate}
          disabled={isGenerating && activeJobCount >= 4}
          className={`w-full py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-all ${
            isGenerating && activeJobCount >= 4
              ? 'bg-surface-200 text-surface-500 cursor-not-allowed'
              : 'bg-gradient-to-r from-accent-600 to-brand-600 text-white hover:from-accent-500 hover:to-brand-500 shadow-lg shadow-accent-500/25 hover:shadow-accent-500/40 btn-glow'
          }`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {activeJobCount >= 4 ? t('create.queued') : `${t('create.generating')} (${activeJobCount}/4)`}
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              {t('create.generate')}
            </>
          )}
        </button>
      </div>

      {/* Modals */}
      <LoraManager
        isOpen={showLoraManager}
        onClose={() => setShowLoraManager(false)}
        token={token || ''}
        loraLoaded={loraLoaded}
        loraEnabled={loraEnabled}
        loraScale={loraScale}
        loraPath={loraPath}
        loraTriggerTag={loraTriggerTag}
        loraTagPosition={loraTagPosition}
        selectedLoraName={selectedLoraName}
        onLoadLora={handleLoraLoad}
        onUnloadLora={handleLoraUnload}
        onSetScale={setLoraScale}
        onToggleEnabled={handleLoraToggle}
        onSetTagPosition={handleLoraTagPosition}
      />
      <MicRecorder
        isOpen={showMicRecorder}
        onClose={() => setShowMicRecorder(false)}
        onAccept={handleMicAccept}
        targetSection={micTarget}
        lyrics={params.lyrics}
        onLyricsChange={l => set('lyrics', l)}
      />
    </div>
  );
})

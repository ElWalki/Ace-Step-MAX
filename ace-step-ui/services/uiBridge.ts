/**
 * UIBridge — Bidirectional state bridge between CreatePanel and ChatAssistant.
 *
 * Architecture:
 *   CreatePanel registers a lazy state provider + listens for action events.
 *   ChatAssistant reads state on-demand (before each LLM call) and dispatches
 *   actions parsed from LLM responses.
 *
 * This singleton avoids lifting 170+ useState vars to App.tsx.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoraInfo {
  name: string;
  source?: string;
  variants?: string[];
  metadata?: Record<string, any>;
}

export interface ModelInfo {
  name: string;
  is_active?: boolean;
  is_preloaded?: boolean;
}

export interface VramInfo {
  used_mb: number;
  total_mb: number;
  free_mb: number;
  percent: number;
}

export interface LLMStatusInfo {
  loaded: boolean;
  model: string;
  backend: string;
}

/** Snapshot of all meaningful generation/config state in CreatePanel. */
export interface UIState {
  // --- Core creative fields ---
  customMode: boolean;
  songDescription: string;
  lyrics: string;
  style: string;
  title: string;
  instrumental: boolean;
  vocalLanguage: string;
  vocalGender: string; // 'male' | 'female' | ''

  // --- Music theory ---
  bpm: number;
  keyScale: string;
  timeSignature: string;

  // --- Generation quality ---
  inferenceSteps: number;
  guidanceScale: number;
  shift: number;
  inferMethod: string; // 'ode' | 'sde'
  thinking: boolean;
  enhance: boolean;
  audioFormat: string; // 'mp3' | 'flac'

  // --- Duration / batching ---
  duration: number;     // -1 = auto
  batchSize: number;
  bulkCount: number;
  randomSeed: boolean;
  seed: number;

  // --- Task type ---
  taskType: string;     // 'text2music' | 'audio2audio' | 'cover' | 'repaint' | 'lego'

  // --- Model ---
  selectedModel: string;
  lmBackend: string;    // 'pt' | 'vllm'
  lmModel: string;

  // --- LM sampling ---
  lmTemperature: number;
  lmCfgScale: number;
  lmTopK: number;
  lmTopP: number;
  lmNegativePrompt: string;

  // --- Audio references ---
  referenceAudioUrl: string;
  referenceAudioTitle: string;
  sourceAudioUrl: string;
  sourceAudioTitle: string;
  audioCoverStrength: number;
  sourceStrength: number;
  audioCodes: string;

  // --- Repaint / edit ---
  repaintingStart: number;
  repaintingEnd: number;
  instruction: string;
  editMode: boolean;
  editAction: string;   // 'repaint' | 'extend'
  editTarget: string;   // 'both' | 'vocals' | 'instrumental'
  editStart: number;
  editEnd: number;

  // --- LoRA ---
  loraPath: string;
  loraLoaded: boolean;
  loraEnabled: boolean;
  loraScale: number;
  loraTriggerTag: string;
  loraTagPosition: string;  // 'prepend' | 'append'
  selectedLoraName: string;
  selectedLoraVariant: string;
  loraList: LoraInfo[];

  // --- Variation mode ---
  variationMode: boolean;
  audioInfluence: number;
  styleInfluence: number;
  weirdness: number;

  // --- Melodic / APG ---
  sectionMeasures: number;
  melodicVariation: number;
  apgNormThreshold: number;
  apgMomentum: number;
  apgEta: number;
  noRepeatNgramSize: number;
  vocalRange: number;
  vocalStyle: number;
  noteSustain: number;

  // --- Advanced toggles ---
  useAdg: boolean;
  cfgIntervalStart: number;
  cfgIntervalEnd: number;
  useCotMetas: boolean;
  useCotCaption: boolean;
  useCotLanguage: boolean;
  autogen: boolean;
  getScores: boolean;
  getLrc: boolean;
  scoreScale: number;
  lmBatchChunkSize: number;
  alignToMeasures: boolean;
  isFormatCaption: boolean;
  maxDurationWithLm: number;
  maxDurationWithoutLm: number;
  trackName: string;
  completeTrackClasses: string;

  // --- Vocal separation ---
  vocalAudioUrl: string;
  vocalAudioTitle: string;
  instrumentalAudioUrl: string;
  separationQuality: string;
  useVocalAsReference: boolean;
  useInstrumentalAsSource: boolean;

  // --- Read-only info ---
  fetchedModels: ModelInfo[];
  vramStatus: VramInfo | null;
  llmStatus: LLMStatusInfo | null;
  musicTags: { label: string; tier: string }[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type UIAction =
  | { type: 'set'; params: Partial<UIState> }
  | { type: 'generate' }
  | { type: 'loadLora'; name: string; variant?: string }
  | { type: 'unloadLora' }
  | { type: 'swapModel'; model: string }
  | { type: 'purgeVram' };

// ---------------------------------------------------------------------------
// Bridge singleton
// ---------------------------------------------------------------------------

type ActionHandler = (action: UIAction) => void;

class UIBridge {
  private stateProvider: (() => UIState) | null = null;
  private actionListeners = new Set<ActionHandler>();
  private stateListeners = new Set<() => void>();

  // ----- State provider (CreatePanel) -----

  /** CreatePanel registers a function that returns the current snapshot. */
  registerStateProvider(provider: () => UIState): void {
    this.stateProvider = provider;
    this.notifyStateListeners();
  }

  /** CreatePanel unregisters on unmount. */
  unregisterStateProvider(): void {
    this.stateProvider = null;
  }

  /** ChatAssistant reads current state on-demand. */
  getState(): UIState | null {
    return this.stateProvider?.() ?? null;
  }

  // ----- Action dispatch (ChatAssistant → CreatePanel) -----

  /** CreatePanel subscribes to actions. Returns unsubscribe fn. */
  onAction(handler: ActionHandler): () => void {
    this.actionListeners.add(handler);
    return () => { this.actionListeners.delete(handler); };
  }

  /** ChatAssistant dispatches an action. */
  dispatch(action: UIAction): void {
    for (const h of this.actionListeners) {
      try { h(action); } catch (e) { console.error('[UIBridge] Action handler error:', e); }
    }
    // Notify state listeners after action (state might have changed)
    requestAnimationFrame(() => this.notifyStateListeners());
  }

  /** Dispatch multiple actions atomically. */
  dispatchBatch(actions: UIAction[]): void {
    for (const action of actions) {
      for (const h of this.actionListeners) {
        try { h(action); } catch (e) { console.error('[UIBridge] Action handler error:', e); }
      }
    }
    requestAnimationFrame(() => this.notifyStateListeners());
  }

  // ----- State change notification -----

  /** Subscribe to state changes (for reactive components). Returns unsubscribe fn. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** Notify that CreatePanel state has changed. */
  notifyStateChange(): void {
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    for (const l of this.stateListeners) {
      try { l(); } catch (e) { console.error('[UIBridge] State listener error:', e); }
    }
  }

  // ----- Helpers -----

  get isConnected(): boolean {
    return this.stateProvider !== null;
  }
}

/** Global singleton — import from anywhere. */
export const uiBridge = new UIBridge();

// ---------------------------------------------------------------------------
// Action parsing from LLM response
// ---------------------------------------------------------------------------

/**
 * Parse `<ui_actions>...</ui_actions>` blocks from LLM text.
 * Returns the extracted actions + the cleaned text (without the block).
 */
export function parseUIActions(text: string): { cleanText: string; actions: UIAction[] } {
  const actionBlockRe = /<ui_actions>\s*([\s\S]*?)\s*<\/ui_actions>/gi;
  let actions: UIAction[] = [];
  let cleanText = text;

  let match: RegExpExecArray | null;
  while ((match = actionBlockRe.exec(text)) !== null) {
    cleanText = cleanText.replace(match[0], '').trim();
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const action = normalizeAction(item);
        if (action) actions.push(action);
      }
    } catch (e) {
      console.warn('[UIBridge] Failed to parse ui_actions block:', e);
    }
  }

  // Also support ```ace_actions ... ``` fenced blocks
  const fencedRe = /```ace_actions\s*([\s\S]*?)\s*```/gi;
  while ((match = fencedRe.exec(text)) !== null) {
    cleanText = cleanText.replace(match[0], '').trim();
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const action = normalizeAction(item);
        if (action) actions.push(action);
      }
    } catch (e) {
      console.warn('[UIBridge] Failed to parse ace_actions block:', e);
    }
  }

  return { cleanText, actions };
}

function normalizeAction(raw: any): UIAction | null {
  if (!raw || typeof raw !== 'object') return null;

  // { "action": "generate" }
  if (raw.action === 'generate' || raw.type === 'generate') {
    return { type: 'generate' };
  }

  // { "action": "swapModel", "model": "..." }
  if ((raw.action === 'swapModel' || raw.type === 'swapModel') && raw.model) {
    return { type: 'swapModel', model: raw.model };
  }

  // { "action": "loadLora", "name": "...", "variant": "..." }
  if ((raw.action === 'loadLora' || raw.type === 'loadLora') && raw.name) {
    return { type: 'loadLora', name: raw.name, variant: raw.variant };
  }

  // { "action": "unloadLora" }
  if (raw.action === 'unloadLora' || raw.type === 'unloadLora') {
    return { type: 'unloadLora' };
  }

  // { "action": "purgeVram" }
  if (raw.action === 'purgeVram' || raw.type === 'purgeVram') {
    return { type: 'purgeVram' };
  }

  // { "action": "set", "params": { ... } }  OR  { "set": "param", "value": val }
  if (raw.action === 'set' || raw.type === 'set') {
    if (raw.params && typeof raw.params === 'object') {
      return { type: 'set', params: raw.params };
    }
    if (raw.param && raw.value !== undefined) {
      return { type: 'set', params: { [raw.param]: raw.value } as any };
    }
  }

  // Shorthand: { "inferenceSteps": 50, "guidanceScale": 7.5 }
  // (any object with known param keys)
  const KNOWN_PARAMS = new Set([
    'lyrics', 'style', 'title', 'instrumental', 'vocalLanguage', 'vocalGender',
    'bpm', 'keyScale', 'timeSignature', 'inferenceSteps', 'guidanceScale', 'shift',
    'inferMethod', 'thinking', 'enhance', 'audioFormat', 'duration', 'batchSize',
    'bulkCount', 'randomSeed', 'seed', 'taskType', 'selectedModel', 'lmBackend',
    'lmModel', 'lmTemperature', 'lmCfgScale', 'lmTopK', 'lmTopP', 'lmNegativePrompt',
    'referenceAudioUrl', 'referenceAudioTitle', 'sourceAudioUrl', 'sourceAudioTitle',
    'audioCoverStrength', 'sourceStrength', 'audioCodes',
    'repaintingStart', 'repaintingEnd', 'instruction', 'editMode', 'editAction',
    'editTarget', 'editStart', 'editEnd', 'loraScale', 'loraEnabled', 'loraTriggerTag',
    'loraPath', 'loraTagPosition', 'selectedLoraName', 'selectedLoraVariant',
    'variationMode', 'audioInfluence', 'styleInfluence', 'weirdness',
    'sectionMeasures', 'melodicVariation', 'apgNormThreshold', 'apgMomentum', 'apgEta',
    'noRepeatNgramSize', 'vocalRange', 'vocalStyle', 'noteSustain', 'customMode',
    'songDescription', 'useAdg', 'cfgIntervalStart', 'cfgIntervalEnd',
    'useCotMetas', 'useCotCaption', 'useCotLanguage', 'autogen', 'getScores', 'getLrc',
    'scoreScale', 'lmBatchChunkSize', 'alignToMeasures', 'isFormatCaption',
    'trackName', 'completeTrackClasses',
    'separationQuality', 'useVocalAsReference', 'useInstrumentalAsSource',
  ]);

  const paramKeys = Object.keys(raw).filter(k => KNOWN_PARAMS.has(k));
  if (paramKeys.length > 0) {
    const params: Record<string, any> = {};
    for (const k of paramKeys) params[k] = raw[k];
    return { type: 'set', params: params as any };
  }

  return null;
}

// ---------------------------------------------------------------------------
// State formatting for LLM context
// ---------------------------------------------------------------------------

/** Serialize UIState into a compact human-readable string for injection into system prompt. */
export function formatUIStateForLLM(state: UIState): string {
  const lines: string[] = [];

  lines.push('═══ ESTADO ACTUAL DE LA UI ═══');
  lines.push('(Estos son los valores configurados AHORA MISMO en el panel de generación)');
  lines.push('');

  // Core
  lines.push(`📋 Modo: ${state.customMode ? 'Personalizado (Custom)' : 'Descripción simple'}`);
  if (!state.customMode && state.songDescription) lines.push(`   Descripción: "${state.songDescription}"`);
  lines.push(`🎯 Tipo de tarea: ${state.taskType}`);
  lines.push(`🎵 Título: ${state.title || '(vacío)'}`);
  lines.push(`🎨 Estilo/Tags: ${state.style || '(vacío)'}`);
  lines.push(`📝 Letra: ${state.lyrics ? `(${state.lyrics.length} caracteres) "${state.lyrics.substring(0, 80)}${state.lyrics.length > 80 ? '...' : ''}"` : '(vacío)'}`);
  lines.push(`🎤 Instrumental: ${state.instrumental ? 'Sí' : 'No'}`);
  lines.push(`🌍 Idioma vocal: ${state.vocalLanguage || 'auto'}`);
  if (state.vocalGender) lines.push(`👤 Género vocal: ${state.vocalGender}`);

  // Music theory
  lines.push('');
  lines.push(`🥁 BPM: ${state.bpm || 'Auto'}`);
  lines.push(`🎹 Tonalidad: ${state.keyScale || 'Auto'}`);
  lines.push(`📐 Compás: ${state.timeSignature ? state.timeSignature + '/4' : 'Auto'}`);

  // Quality
  lines.push('');
  lines.push(`⚙️ Modelo DIT: ${state.selectedModel}`);
  lines.push(`🧠 Modelo LM: ${state.lmModel} (backend: ${state.lmBackend})`);
  lines.push(`🔄 Pasos de inferencia: ${state.inferenceSteps}`);
  lines.push(`🎯 Guidance Scale: ${state.guidanceScale}`);
  lines.push(`📐 Shift: ${state.shift}`);
  lines.push(`🔀 Método: ${state.inferMethod}`);
  lines.push(`💭 Thinking: ${state.thinking ? 'Activado' : 'Desactivado'}`);
  lines.push(`✨ Enhance: ${state.enhance ? 'Activado' : 'Desactivado'}`);
  lines.push(`📦 Formato: ${state.audioFormat}`);

  // Duration / batch
  lines.push('');
  lines.push(`⏱️ Duración: ${state.duration === -1 ? 'Auto' : state.duration + 's'}`);
  lines.push(`📦 Batch size: ${state.batchSize}`);
  lines.push(`🔁 Bulk count: ${state.bulkCount}`);
  lines.push(`🎲 Seed: ${state.randomSeed ? 'Aleatorio' : state.seed}`);

  // LM sampling
  lines.push('');
  lines.push(`🌡️ LM Temperature: ${state.lmTemperature}`);
  lines.push(`📊 LM CFG Scale: ${state.lmCfgScale}`);
  lines.push(`🔝 LM Top-K: ${state.lmTopK}`);
  lines.push(`📈 LM Top-P: ${state.lmTopP}`);

  // Audio references
  if (state.referenceAudioUrl || state.sourceAudioUrl) {
    lines.push('');
    if (state.referenceAudioUrl) {
      lines.push(`🔊 Audio referencia: "${state.referenceAudioTitle || 'Sin nombre'}" (strength: ${state.audioCoverStrength})`);
    }
    if (state.sourceAudioUrl) {
      lines.push(`🎵 Audio source: "${state.sourceAudioTitle || 'Sin nombre'}" (strength: ${state.sourceStrength})`);
    }
  }

  // LoRA
  if (state.loraLoaded || state.selectedLoraName) {
    lines.push('');
    lines.push(`🧬 LoRA: ${state.selectedLoraName || state.loraPath}`);
    lines.push(`   Cargada: ${state.loraLoaded ? 'Sí' : 'No'} | Activada: ${state.loraEnabled ? 'Sí' : 'No'} | Escala: ${state.loraScale}`);
    if (state.loraTriggerTag) lines.push(`   Trigger tag: "${state.loraTriggerTag}" (${state.loraTagPosition})`);
  }

  // LoRA list
  if (state.loraList.length > 0) {
    lines.push(`   LoRAs disponibles: ${state.loraList.map(l => l.name).join(', ')}`);
  }

  // Variation mode
  if (state.variationMode) {
    lines.push('');
    lines.push(`🎛️ Modo Variación: ACTIVO`);
    lines.push(`   Audio Influence: ${state.audioInfluence}% | Style: ${state.styleInfluence}% | Weirdness: ${state.weirdness}%`);
  }

  // Edit mode
  if (state.editMode) {
    lines.push('');
    lines.push(`✏️ Modo Edición: ACTIVO (${state.editAction} - ${state.editTarget})`);
    lines.push(`   Rango: ${state.editStart}s → ${state.editEnd === -1 ? 'final' : state.editEnd + 's'}`);
  }

  // Models available
  if (state.fetchedModels.length > 0) {
    lines.push('');
    lines.push(`📦 Modelos disponibles: ${state.fetchedModels.map(m => `${m.name}${m.is_active ? ' ⭐' : ''}`).join(', ')}`);
  }

  // VRAM
  if (state.vramStatus) {
    lines.push('');
    lines.push(`💾 VRAM: ${state.vramStatus.used_mb.toFixed(0)}MB / ${state.vramStatus.total_mb.toFixed(0)}MB (${state.vramStatus.percent.toFixed(0)}% usado)`);
  }

  // LLM status
  if (state.llmStatus) {
    lines.push(`🤖 Backend LLM: ${state.llmStatus.loaded ? 'Cargado' : 'No cargado'} — ${state.llmStatus.model} (${state.llmStatus.backend})`);
  }

  // Advanced toggles
  const advancedToggles: string[] = [];
  if (state.useAdg) advancedToggles.push('ADG');
  if (state.useCotMetas) advancedToggles.push('CoT-Metas');
  if (state.useCotCaption) advancedToggles.push('CoT-Caption');
  if (state.useCotLanguage) advancedToggles.push('CoT-Language');
  if (state.autogen) advancedToggles.push('Autogen');
  if (state.isFormatCaption) advancedToggles.push('Format-Caption');
  if (state.getScores) advancedToggles.push('Get-Scores');
  if (state.getLrc) advancedToggles.push('Get-LRC');
  if (state.alignToMeasures) advancedToggles.push('Align-Measures');
  if (advancedToggles.length > 0) {
    lines.push('');
    lines.push(`🔧 Toggles activos: ${advancedToggles.join(', ')}`);
  }

  // CFG interval
  if (state.cfgIntervalStart !== undefined || state.cfgIntervalEnd !== undefined) {
    lines.push(`📊 CFG Interval: ${state.cfgIntervalStart ?? 0} → ${state.cfgIntervalEnd ?? 1}`);
  }

  // LM negative prompt
  if (state.lmNegativePrompt) {
    lines.push(`🚫 Negative prompt: "${state.lmNegativePrompt}"`);
  }

  // Score/LM batch
  if (state.scoreScale) lines.push(`📏 Score Scale: ${state.scoreScale}`);
  if (state.lmBatchChunkSize) lines.push(`📦 LM Batch Chunk: ${state.lmBatchChunkSize}`);

  // Track/pistas
  if (state.trackName) lines.push(`🎼 Track Name: ${state.trackName}`);
  if (state.completeTrackClasses) lines.push(`🎹 Track Classes: ${state.completeTrackClasses}`);

  // Repaint
  if (state.repaintingStart > 0 || state.repaintingEnd < 1) {
    lines.push(`🎨 Repaint: ${state.repaintingStart} → ${state.repaintingEnd}`);
  }
  if (state.instruction) lines.push(`💬 Instruction: "${state.instruction}"`);

  // Melodic/APG (only show if non-default)
  if (state.sectionMeasures) lines.push(`🎵 Section Measures: ${state.sectionMeasures}`);
  if (state.melodicVariation) lines.push(`🎶 Melodic Variation: ${state.melodicVariation}`);
  if (state.noRepeatNgramSize) lines.push(`🔁 No-Repeat N-gram: ${state.noRepeatNgramSize}`);

  // Audio codes
  if (state.audioCodes) {
    const codeCount = (state.audioCodes.match(/<\|audio_code_\d+\|>/g) || []).length;
    lines.push(`🧬 Audio Codes: ${codeCount} tokens semánticos cargados`);
  }

  // Vocal separation
  if (state.vocalAudioUrl) {
    lines.push('');
    lines.push(`🎙️ Vocal separada: "${state.vocalAudioTitle || 'vocal'}" (usar como ref: ${state.useVocalAsReference ? 'sí' : 'no'})`);
  }
  if (state.instrumentalAudioUrl) {
    lines.push(`🎸 Instrumental separada: disponible (usar como source: ${state.useInstrumentalAsSource ? 'sí' : 'no'})`);
  }

  return lines.join('\n');
}

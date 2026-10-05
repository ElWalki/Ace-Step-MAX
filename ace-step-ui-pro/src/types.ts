export interface Song {
  id: string;
  title: string;
  lyrics: string;
  style: string;
  coverUrl: string;
  duration: string;
  createdAt: Date;
  isGenerating?: boolean;
  queuePosition?: number;
  progress?: number;
  stage?: string;
  generationParams?: GenerationParams;
  tags: string[];
  audioUrl?: string;
  isPublic?: boolean;
  likeCount?: number;
  viewCount?: number;
  userId?: string;
  creator?: string;
  ditModel?: string;
  liked?: boolean;
  prompt?: string;
}

/** Options for regenerating a selected region of a clip (in-clip repaint). */
export interface RegionRegenOptions {
  /** Absolute start of the region, in SECONDS. */
  startSec: number;
  /** Absolute end of the region, in SECONDS. */
  endSec: number;
  /** Optional style/prompt override for the regenerated section. */
  prompt?: string;
  /** Optional lyrics override for the regeneration. */
  lyrics?: string;
}

/** One region of a multi-selection repaint (all fields per-region overrides). */
export interface RepaintRegionSpec {
  start: number;   // seconds
  end: number;     // seconds
  style?: string;
  lyrics?: string;
  loraPath?: string;
  loraName?: string;
  loraScale?: number;
}

export interface StyleDna {
  enabled: boolean;
  energy: number;         // 0-100: calm → intense
  danceability: number;   // 0-100: ambient → groovy
  valence: number;        // 0-100: dark → bright
  acousticness: number;   // 0-100: electronic → acoustic
  vocalIntensity: number; // 0-100: whisper → belting
  complexity: number;     // 0-100: minimal → dense
}

export const DEFAULT_STYLE_DNA: StyleDna = {
  enabled: false,
  energy: 50,
  danceability: 50,
  valence: 50,
  acousticness: 50,
  vocalIntensity: 50,
  complexity: 50,
};

// Per-section-tag cadence settings
export interface TagCadence {
  tag: string;           // e.g. '[Verse]'
  wordsPerLine: number;  // target words per line (0 = auto)
  density: 'sparse' | 'normal' | 'dense' | 'rapid';
  mood?: string;         // optional mood override per section
}

export const DENSITY_LABELS = {
  sparse: { en: 'Sparse', es: 'Disperso', wordsRange: '2-4' },
  normal: { en: 'Normal', es: 'Normal', wordsRange: '5-8' },
  dense:  { en: 'Dense',  es: 'Denso',  wordsRange: '8-12' },
  rapid:  { en: 'Rapid',  es: 'Rápido', wordsRange: '12+' },
} as const;

export const DEFAULT_TAG_CADENCES: Record<string, TagCadence> = {
  '[Intro]':      { tag: '[Intro]',      wordsPerLine: 4,  density: 'sparse' },
  '[Verse]':      { tag: '[Verse]',      wordsPerLine: 8,  density: 'normal' },
  '[Pre-Chorus]': { tag: '[Pre-Chorus]', wordsPerLine: 7,  density: 'normal' },
  '[Chorus]':     { tag: '[Chorus]',     wordsPerLine: 6,  density: 'dense' },
  '[Bridge]':     { tag: '[Bridge]',     wordsPerLine: 6,  density: 'normal' },
  '[Outro]':      { tag: '[Outro]',      wordsPerLine: 4,  density: 'sparse' },
  '[Rap]':        { tag: '[Rap]',        wordsPerLine: 12, density: 'rapid' },
  '[Break]':      { tag: '[Break]',      wordsPerLine: 0,  density: 'sparse' },
};

// Build cadence hints to inject into lyrics as hidden guidance
export function buildTagCadenceHints(cadences: Record<string, TagCadence>): string {
  const hints: string[] = [];
  for (const [tag, c] of Object.entries(cadences)) {
    const parts: string[] = [];
    if (c.wordsPerLine > 0) parts.push(`~${c.wordsPerLine} words/line`);
    if (c.density !== 'normal') parts.push(`${c.density} delivery`);
    if (c.mood) parts.push(c.mood);
    if (parts.length > 0) {
      hints.push(`${tag}: ${parts.join(', ')}`);
    }
  }
  return hints.join('; ');
}

// Maps StyleDna slider values to descriptive tags injected into caption
export function buildStyleDnaTags(dna: StyleDna): string {
  if (!dna.enabled) return '';
  const tags: string[] = [];

  // Energy
  if (dna.energy <= 20) tags.push('calm', 'mellow', 'relaxed');
  else if (dna.energy <= 40) tags.push('laid-back', 'smooth');
  else if (dna.energy >= 80) tags.push('energetic', 'powerful', 'intense', 'driving');
  else if (dna.energy >= 60) tags.push('upbeat', 'lively');

  // Danceability
  if (dna.danceability <= 20) tags.push('ambient', 'ethereal');
  else if (dna.danceability <= 40) tags.push('contemplative', 'flowing');
  else if (dna.danceability >= 80) tags.push('danceable', 'groovy', 'rhythmic');
  else if (dna.danceability >= 60) tags.push('bouncy', 'catchy');

  // Valence (mood)
  if (dna.valence <= 20) tags.push('dark', 'melancholic', 'somber');
  else if (dna.valence <= 40) tags.push('moody', 'introspective');
  else if (dna.valence >= 80) tags.push('uplifting', 'happy', 'euphoric');
  else if (dna.valence >= 60) tags.push('bright', 'cheerful');

  // Acousticness
  if (dna.acousticness <= 20) tags.push('electronic', 'synthesized', 'digital');
  else if (dna.acousticness <= 40) tags.push('processed', 'polished');
  else if (dna.acousticness >= 80) tags.push('acoustic', 'organic', 'unplugged');
  else if (dna.acousticness >= 60) tags.push('natural', 'warm');

  // Vocal intensity
  if (dna.vocalIntensity <= 20) tags.push('soft vocal', 'whispered', 'gentle singing');
  else if (dna.vocalIntensity <= 40) tags.push('smooth vocal', 'tender');
  else if (dna.vocalIntensity >= 80) tags.push('powerful vocal', 'belting', 'soaring');
  else if (dna.vocalIntensity >= 60) tags.push('strong vocal', 'expressive');

  // Complexity / arrangement
  if (dna.complexity <= 20) tags.push('minimal', 'sparse');
  else if (dna.complexity <= 40) tags.push('simple', 'clean');
  else if (dna.complexity >= 80) tags.push('complex', 'layered', 'dense arrangement');
  else if (dna.complexity >= 60) tags.push('rich', 'textured');

  return tags.join(', ');
}

// Derive model-level parameters from StyleDna
export function styleDnaToModelParams(dna: StyleDna): {
  lmRepetitionPenalty?: number;
  noRepeatNgramSize?: number;
  apgEta?: number;
} {
  if (!dna.enabled) return {};
  const out: { lmRepetitionPenalty?: number; noRepeatNgramSize?: number; apgEta?: number } = {};

  // Complexity → repetition penalty (more complex = higher penalty = more variation)
  // Range: 1.0 (simple/repetitive) → 1.5 (complex/varied)
  out.lmRepetitionPenalty = 1.0 + (dna.complexity / 100) * 0.5;

  // Danceability + complexity → n-gram blocking
  // High danceability = allow more repetition (lower ngram), high complexity = block more repeats
  if (dna.complexity >= 70 && dna.danceability < 50) {
    out.noRepeatNgramSize = 3;
  }

  // Energy → APG eta (higher energy = amplify pitch patterns)
  if (dna.energy >= 60) {
    out.apgEta = (dna.energy - 50) / 100 * 0.4; // 0 → 0.2 range
  }

  return out;
}

// Individually toggleable caption tag packs. Each appends vocabulary the model was
// trained on (production/era/mix descriptors), conditioning the LM caption → latent space.
export interface CaptionBooster {
  id: string;
  label: string;
  tags: string;
}

export const CAPTION_BOOSTERS: CaptionBooster[] = [
  { id: 'studio',    label: 'Studio Quality', tags: 'studio quality, professional mix, clean master' },
  { id: 'lofi',      label: 'Lo-Fi',          tags: 'lo-fi, tape hiss, vintage warmth' },
  { id: 'live',      label: 'Live',           tags: 'live recording, room ambience, natural reverb' },
  { id: 'analog80s', label: 'Analog 80s',     tags: '80s production, analog synths, gated reverb drums, tape saturation' },
  { id: 'nineties',  label: '90s',            tags: '90s production, sampled drums, warm analog mix' },
  { id: 'modern',    label: 'Modern',         tags: 'modern production, polished mix, contemporary sound' },
  { id: 'wide',      label: 'Wide / Reverb',  tags: 'wide stereo image, lush reverb, spacious mix' },
  { id: 'dry',       label: 'Dry / Intimate', tags: 'dry mix, intimate, close-mic vocals' },
  { id: 'punchy',    label: 'Punchy Low End', tags: 'punchy drums, deep bass, tight low end' },
  { id: 'cinematic', label: 'Cinematic',      tags: 'cinematic, epic, orchestral layers, dramatic dynamics' },
];

// Mirrors backend parse_and_validate_timesteps + the model's Euler loop:
// values must be within [0,1] (else the whole list is silently dropped) and
// strictly descending (else dt goes negative and corrupts that step silently).
export interface TimestepsCheck {
  ok: boolean;
  steps: number;
  values: number[];
  error?: 'format' | 'range' | 'order';
}

export function validateTimesteps(raw: string | undefined): TimestepsCheck | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const parts = s.split(',').map(v => v.trim()).filter(Boolean);
  if (!parts.length) return null;
  const values = parts.map(Number);
  if (values.some(v => Number.isNaN(v))) return { ok: false, steps: 0, values: [], error: 'format' };
  if (values.some(v => v < 0 || v > 1)) return { ok: false, steps: 0, values, error: 'range' };
  const full = values[values.length - 1] === 0 ? values : [...values, 0];
  for (let i = 1; i < full.length; i++) {
    if (full[i] >= full[i - 1]) return { ok: false, steps: full.length - 1, values: full, error: 'order' };
  }
  return { ok: true, steps: full.length - 1, values: full };
}

export type TimestepShape = 'structure' | 'linear' | 'detail';

// Power-curve schedule on top of a linear 1→0 grid. Exponent <1 packs steps near t≈1
// (global structure), >1 packs them near t≈0 (fine detail). shift=1 linear ≡ backend default.
export const TIMESTEP_SHAPES: { id: TimestepShape; label: string; exponent: number }[] = [
  { id: 'structure', label: 'Structure', exponent: 0.55 },
  { id: 'linear',    label: 'Linear',    exponent: 1.0 },
  { id: 'detail',    label: 'Detail',    exponent: 1.8 },
];

export function buildTimestepSchedule(steps: number, shape: TimestepShape): string {
  const n = Math.max(1, Math.min(300, Math.round(steps)));
  const exp = TIMESTEP_SHAPES.find(s => s.id === shape)?.exponent ?? 1;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = 1 - i / n;
    out.push(+Math.pow(u, exp).toFixed(4));
  }
  // Guarantee strict descent after rounding (dense schedules can collapse neighbours)
  for (let i = 1; i < out.length; i++) {
    if (out[i] >= out[i - 1]) out[i] = +Math.max(0, out[i - 1] - 0.0001).toFixed(4);
  }
  out[out.length - 1] = 0;
  return out.join(', ');
}

// Generation pipeline presets: pure diffusion vs LM-guided (autoregressive codes steer the DiT).
export type GenerationMode = 'diffusion' | 'ar' | 'arLocked';

export const GENERATION_MODES: {
  id: GenerationMode;
  label: string;
  desc: string;
  apply: Partial<GenerationParams>;
}[] = [
  {
    id: 'diffusion',
    label: 'Diffusion',
    desc: 'Text → DiT directly. Fastest, most random. Good for quick style exploration.',
    apply: { thinking: false },
  },
  {
    id: 'ar',
    label: 'AR-guided',
    desc: '5Hz LM writes audio codes token-by-token, then the DiT renders them. Best structure and lyric adherence.',
    apply: { thinking: true, useCotMetas: true, useCotCaption: true, useCotLanguage: true },
  },
  {
    id: 'arLocked',
    label: 'AR · Locked',
    desc: 'AR-guided but the LM must respect your exact caption, BPM and key. Maximum reproducibility for iterating.',
    apply: { thinking: true, useCotMetas: false, useCotCaption: false, useCotLanguage: false },
  },
];

export function detectGenerationMode(p: GenerationParams): GenerationMode {
  if (!p.thinking) return 'diffusion';
  const locked = p.useCotMetas === false && p.useCotCaption === false;
  return locked ? 'arLocked' : 'ar';
}

// Consistency macro (0 = wild / 100 = locked). Only touches knobs the checkpoints
// actually read: LM sampling (temperature/top-p/rep-penalty/n-gram) + DiT guidance.
export const CONSISTENCY_NEUTRAL = 50;

export function consistencyToParams(level: number): Pick<GenerationParams,
  'lmTemperature' | 'lmTopP' | 'lmTopK' | 'lmRepetitionPenalty' | 'noRepeatNgramSize' | 'lmCfgScale' | 'guidanceScale'> {
  const x = Math.max(0, Math.min(100, level)) / 100;          // 0..1
  const lerp = (a: number, b: number) => +(a + (b - a) * x).toFixed(3);
  return {
    lmTemperature: lerp(1.25, 0.55),        // hotter codes ↔ deterministic codes
    lmTopP: lerp(0.98, 0.80),               // wide nucleus ↔ tight nucleus
    lmTopK: Math.round(lerp(200, 40)),
    lmRepetitionPenalty: lerp(1.05, 1.35),  // let motifs repeat ↔ discourage stuck loops
    noRepeatNgramSize: x >= 0.7 ? 3 : 0,    // block 3-code (~600ms) loops only when locking
    lmCfgScale: lerp(1.2, 2.6),             // LM follows prompt loosely ↔ tightly
    guidanceScale: lerp(5, 10),             // DiT text adherence (kept under APG saturation zone)
  };
}

export interface GenerationParams {
  customMode: boolean;
  songDescription?: string;
  prompt: string;
  lyrics: string;
  style: string;
  title: string;
  styleDna?: StyleDna;
  captionBoosters?: string[];
  ditModel?: string;
  instrumental: boolean;
  singer: '' | 'male' | 'female';
  vocalLanguage: string;
  bpm: number;
  keyScale: string;
  timeSignature: string;
  duration: number;
  inferenceSteps: number;
  guidanceScale: number;
  batchSize: number;
  randomSeed: boolean;
  seed: number;
  actualSeed?: number;
  thinking: boolean;
  enhance?: boolean;
  audioFormat: 'mp3' | 'flac' | 'wav';
  inferMethod: 'ode' | 'sde';
  shift: number;
  lmTemperature: number;
  lmCfgScale: number;
  lmTopK: number;
  lmTopP: number;
  lmNegativePrompt: string;
  lmBackend?: 'pt' | 'vllm';
  lmModel?: string;
  lmRepetitionPenalty?: number;
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  referenceAudioTitle?: string;
  sourceAudioTitle?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  repaintRegions?: RepaintRegionSpec[];
  instruction?: string;
  vocalAudioUrl?: string;
  vocalAudioTitle?: string;
  audioCoverStrength?: number;
  referenceStrength?: number;
  ignoreAudioInput?: boolean;
  taskType?: string;
  useAdg?: boolean;
  cfgIntervalStart?: number;
  cfgIntervalEnd?: number;
  customTimesteps?: string;
  useCotMetas?: boolean;
  useCotCaption?: boolean;
  useCotLanguage?: boolean;
  autogen?: boolean;
  constrainedDecodingDebug?: boolean;
  allowLmBatch?: boolean;
  getScores?: boolean;
  getLrc?: boolean;
  scoreScale?: number;
  lmBatchChunkSize?: number;
  trackName?: string;
  completeTrackClasses?: string[];
  isFormatCaption?: boolean;
  alignToMeasures?: boolean;
  sectionMode?: boolean;
  sectionMeasures?: number;
  melodicVariation?: number;
  apgNormThreshold?: number;
  apgMomentum?: number;
  apgEta?: number;
  noRepeatNgramSize?: number;
  loraLoaded?: boolean;
  loraPath?: string;
  loraName?: string;
  loraScale?: number;
  loraEnabled?: boolean;
  loraTriggerTag?: string;
  loraTagPosition?: string;
}

export interface GenerationJob {
  jobId: string;
  status: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed';
  queuePosition?: number;
  progress?: number;
  stage?: string;
  params?: GenerationParams;
  result?: {
    audioUrls: string[];
    bpm?: number;
    duration?: number;
    keyScale?: string;
    timeSignature?: string;
  };
  error?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  songIds?: string[];
  isPublic?: boolean;
  songs?: Song[];
}

export interface User {
  id: string;
  username: string;
  isAdmin?: boolean;
  avatar_url?: string;
}

export type ChordQuality = 'major' | 'minor' | 'dim' | 'aug' | 'maj7' | 'min7' | 'dom7' | 'dim7' | 'sus2' | 'sus4';
export type ScaleType = 'major' | 'minor';
export type ProgressionMood = 'romantic' | 'dark' | 'upbeat' | 'jazz' | 'latin' | 'lofi' | 'epic' | 'folk';

export interface ChordProgressionState {
  key: string;
  scale: ScaleType;
  roman: string;
  bpm: number;
  beatsPerChord: number;
}

export type ChordInjectionMode = 'style' | 'audioCodes' | 'reference';

export interface ChordApplyData {
  mode: ChordInjectionMode;
  styleTag: string;
  lyricsTag: string;
  keyScaleTag: string;
  /** WAV blob for audioCodes/reference modes */
  audioBlob?: Blob;
}

export interface ChordPreset {
  id: string;
  name: string;
  key: string;
  scale: ScaleType;
  roman: string;
  mood: ProgressionMood;
  description: string;
  emoji: string;
}

export type View = 'create' | 'library' | 'training' | 'explore' | 'gpu' | 'studio' | 'features';

export const DEFAULT_PARAMS: GenerationParams = {
  customMode: false,
  songDescription: '',
  prompt: '',
  lyrics: '',
  style: '',
  title: '',
  instrumental: false,
  singer: '',
  vocalLanguage: 'en',
  bpm: 0, // 0 = Auto — the model picks the tempo from style/reference audio
  keyScale: '',
  timeSignature: '4',
  duration: 120,
  inferenceSteps: 60,
  guidanceScale: 15,
  batchSize: 1,
  randomSeed: true,
  seed: 0,
  thinking: false,
  enhance: false,
  audioFormat: 'mp3',
  inferMethod: 'ode',
  shift: 3,
  lmTemperature: 0.85,
  lmCfgScale: 1.5,
  lmTopK: 100,
  lmTopP: 0.95,
  lmNegativePrompt: '',
  referenceStrength: 1.0,
};

export const KEY_SIGNATURES = [
  '', 'C major', 'C minor', 'C# major', 'C# minor', 'Db major', 'Db minor',
  'D major', 'D minor', 'D# major', 'D# minor', 'Eb major', 'Eb minor',
  'E major', 'E minor', 'F major', 'F minor', 'F# major', 'F# minor',
  'Gb major', 'Gb minor', 'G major', 'G minor', 'G# major', 'G# minor',
  'Ab major', 'Ab minor', 'A major', 'A minor', 'A# major', 'A# minor',
  'Bb major', 'Bb minor', 'B major', 'B minor',
];

export const TIME_SIGNATURES = [
  { value: '', label: 'Auto' },
  { value: '1', label: '1/4' },
  { value: '2', label: '2/4' },
  { value: '3', label: '3/4' },
  { value: '4', label: '4/4' },
  { value: '5', label: '5/4' },
  { value: '6', label: '6/8' },
  { value: '7', label: '7/4' },
  { value: '8', label: '8/4' },
  { value: '3/8', label: '3/8' },
  { value: '3/6', label: '3/6' },
  { value: '4/6', label: '4/6' },
  { value: '1/1', label: '1/1' },
];

export const VOCAL_LANGUAGES = [
  { code: '', label: 'Auto' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'sv', label: 'Svenska' },
  { code: 'da', label: 'Dansk' },
  { code: 'fi', label: 'Suomi' },
  { code: 'no', label: 'Norsk' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'he', label: 'עברית' },
  { code: 'th', label: 'ไทย' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'uk', label: 'Українська' },
  { code: 'ro', label: 'Română' },
  { code: 'hu', label: 'Magyar' },
  { code: 'cs', label: 'Čeština' },
  { code: 'bg', label: 'Български' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'la', label: 'Latin' },
  { code: 'yue', label: '粵語' },
];

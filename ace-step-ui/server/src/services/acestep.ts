import { writeFile, mkdir, copyFile, rm, readFile } from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { handle_file } from '@gradio/client';
import { planSections } from './section-planner.js';

// Get audio duration using ffprobe
function getAudioDuration(filePath: string): number {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : Math.round(duration);
  } catch (error) {
    console.warn('Failed to get audio duration:', error);
    return 0;
  }
}
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { getGradioClient, resetGradioClient, isGradioAvailable } from './gradio-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../public/audio');

const ACESTEP_API = config.acestep.apiUrl;

// Resolve ACE-Step path (from env or default relative path)
function resolveAceStepPath(): string {
  const envPath = process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  // Default: sibling directory (server/src/services -> ../../../ACE-Step-1.5 = app/ACE-Step-1.5)
  return path.resolve(__dirname, '../../../ACE-Step-1.5');
}

// Resolve Python path cross-platform (supports venv and portable installations)
export function resolvePythonPath(baseDir: string): string {
  // Allow explicit override via env var
  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }

  const isWindows = process.platform === 'win32';
  const pythonExe = isWindows ? 'python.exe' : 'python';

  // Check for portable installation first (python_embeded)
  const portablePath = path.join(baseDir, 'python_embeded', pythonExe);
  if (existsSync(portablePath)) {
    return portablePath;
  }

  // Check common venv directory names (Pinokio uses 'env', others use '.venv' or 'venv')
  const venvDirs = ['env', '.venv', 'venv'];
  for (const venvDir of venvDirs) {
    const venvPython = isWindows
      ? path.join(baseDir, venvDir, 'Scripts', pythonExe)
      : path.join(baseDir, venvDir, 'bin', 'python');
    if (existsSync(venvPython)) {
      return venvPython;
    }
  }

  // Fallback to first option (will produce a clear error if not found)
  if (isWindows) {
    return path.join(baseDir, 'env', 'Scripts', pythonExe);
  }
  return path.join(baseDir, 'env', 'bin', 'python');
}

const ACESTEP_DIR = resolveAceStepPath();
const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const PYTHON_SCRIPT = path.join(SCRIPTS_DIR, 'simple_generate.py');

/**
 * Auto-purge VRAM after generation to prevent memory accumulation.
 * Runs gc.collect() + torch.cuda.empty_cache() via the vram_manager script.
 * Non-blocking — errors are silently logged so they never affect generation results.
 */
function autoPurgeVram(): void {
  try {
    const pythonPath = resolvePythonPath(ACESTEP_DIR);
    const scriptPath = path.join(SCRIPTS_DIR, 'vram_manager.py');
    if (!existsSync(scriptPath)) return;

    const proc = spawn(pythonPath, [scriptPath, '--action', 'purge', '--json'], {
      cwd: ACESTEP_DIR,
      env: { ...process.env, ACESTEP_PATH: ACESTEP_DIR },
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        try {
          const lines = stdout.trim().split('\n');
          const jsonStr = lines.find(l => l.startsWith('{')) || '';
          const parsed = JSON.parse(jsonStr);
          const freed = parsed.nvidia_freed_mb || 0;
          if (freed > 0) console.log(`[VRAM] Auto-purge freed ${freed} MB`);
          else console.log('[VRAM] Auto-purge: cache cleared');
        } catch { /* ignore parse errors */ }
      }
    });
    proc.on('error', () => { /* silently ignore */ });
  } catch { /* silently ignore */ }
}

// ---------------------------------------------------------------------------
// Gradio generation: map params to the 45 positional args for /generation_wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve an audio URL (e.g. /audio/file.mp3) to an absolute local file path.
 */
function resolveAudioPath(audioUrl: string): string {
  if (audioUrl.startsWith('/audio/')) {
    return path.join(AUDIO_DIR, audioUrl.replace('/audio/', ''));
  }
  if (audioUrl.startsWith('http')) {
    try {
      const parsed = new URL(audioUrl);
      if (parsed.pathname.startsWith('/audio/')) {
        return path.join(AUDIO_DIR, parsed.pathname.replace('/audio/', ''));
      }
    } catch { /* fall through */ }
  }
  return audioUrl;
}

/**
 * Prepare a local audio file for Gradio upload.
 * Returns a handle_file() wrapper or null if no file.
 */
async function prepareAudioFile(audioUrl: string | undefined): Promise<unknown> {
  if (!audioUrl) return null;

  const filePath = resolveAudioPath(audioUrl);

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.opus': 'audio/opus', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    };
    const mimeType = mimeMap[ext] || 'audio/mpeg';
    const blob = new Blob([buffer], { type: mimeType });
    return handle_file(blob);
  } catch (error) {
    console.warn(`[Gradio] Failed to read audio file ${filePath}:`, error);
    // Fall back to URL-based reference if file can't be read locally
    if (audioUrl.startsWith('http')) {
      return handle_file(audioUrl);
    }
    return null;
  }
}

/**
 * Build the 50 positional arguments for the Gradio /generation_wrapper endpoint.
 */
async function buildGradioArgs(params: GenerationParams): Promise<unknown[]> {
  const caption = params.style || 'pop music';
  let prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');
  const isThinking = params.thinking ?? false;
  const isEnhance = params.enhance ?? false;

  // Inject LoRA trigger tag into the prompt if configured AND LoRA is enabled
  if (params.loraEnabled !== false && params.loraTriggerTag && params.loraTagPosition && params.loraTagPosition !== 'off') {
    const tag = params.loraTriggerTag.trim();
    if (tag) {
      if (params.loraTagPosition === 'prepend') {
        prompt = `${tag}, ${prompt}`;
      } else if (params.loraTagPosition === 'append') {
        prompt = `${prompt}, ${tag}`;
      }
      console.log(`[LoRA] Trigger tag injected (${params.loraTagPosition}): "${tag}"`);
    }
  }

  // Measure alignment: snap duration to complete musical measures
  let duration = params.duration && params.duration > 0 ? params.duration : -1;
  if (params.alignToMeasures && duration > 0) {
    const bpm = (params.bpm && params.bpm > 0) ? params.bpm : 120;
    const tsStr = params.timeSignature || '4';
    const beatsPerMeasure = [2, 3, 4, 5, 6, 7, 8].includes(Number(tsStr)) ? Number(tsStr) : 4;
    const measureDuration = (beatsPerMeasure / bpm) * 60;
    if (measureDuration > 0) {
      const numMeasures = Math.ceil(duration / measureDuration);
      duration = Math.max(10, Math.min(600, Math.round(numMeasures * measureDuration)));
      console.log(`[measure-align] BPM=${bpm}, ts=${beatsPerMeasure}/4, measure=${measureDuration.toFixed(2)}s, measures=${numMeasures}, ${params.duration}s → ${duration}s`);
    }
  }

  // Master switch (advanced mode): force a clean text→music generation, ignoring any
  // reference/cover/source audio still loaded in the UI. Guarantees no hidden audio
  // conditioning leaks into the result.
  const ignoreAudio = params.ignoreAudioInput === true;

  // Prepare audio files (async — reads from disk)
  const referenceAudio = ignoreAudio ? null : await prepareAudioFile(params.referenceAudioUrl);
  const sourceAudio = ignoreAudio ? null : await prepareAudioFile(params.sourceAudioUrl);

  // CoT features are gated by enhance OR thinking (either enables LLM enrichment)
  const useCot = isEnhance || isThinking;

  // Seed handling: the UI rolls a concrete seed per generation when "random" is on (single
  // items), so we usually receive an explicit seed to send and record. When we still get no
  // seed (random multi-item batches, or a direct API call), defer to engine-side random
  // seeding (-1) so each item varies.
  const wantRandom = params.randomSeed !== false;
  const userSeed = params.seed != null && Number(params.seed) > 0 ? Math.floor(Number(params.seed)) : 0;
  const useEngineRandom = wantRandom && userSeed === 0;

  // Position 18 (audio_cover_strength) doubles as the reference "inspiration"
  // strength for pure text2music + reference audio. The Python handler re-clamps
  // the cover value to 1.0 for text2music (the cover branch would crash otherwise)
  // but first captures it as the reference blend strength. For real cover/repaint
  // tasks it keeps its original cover meaning.
  const isCoverish = !ignoreAudio && (params.taskType === 'cover' || params.taskType === 'repaint' || !!params.sourceAudioUrl);
  const strengthArg18 = isCoverish
    ? (params.audioCoverStrength ?? 1.0)
    : (!ignoreAudio && params.referenceAudioUrl ? (params.referenceStrength ?? 1.0) : (params.audioCoverStrength ?? 1.0));

  return [
    prompt,                                                       //  0: Music Caption
    lyrics,                                                       //  1: Lyrics
    params.bpm && params.bpm > 0 ? params.bpm : 0,               //  2: BPM (0 = auto)
    params.keyScale || '',                                        //  3: KeyScale
    params.timeSignature || '',                                   //  4: Time Signature
    params.vocalLanguage || 'en',                                 //  5: Vocal Language
    params.inferenceSteps ?? 8,                                   //  6: DiT Inference Steps
    params.guidanceScale ?? 7.0,                                  //  7: DiT Guidance Scale
    useEngineRandom,                                             //  8: Random Seed (false → use the explicit seed below)
    String(useEngineRandom ? -1 : userSeed),                     //  9: Seed (concrete, recorded & reproducible)
    referenceAudio,                                               // 10: Reference Audio (filepath | null)
    duration,                                                       // 11: Audio Duration (-1 = auto, measure-aligned if enabled)
    Math.min(Math.max(params.batchSize ?? 1, 1), 16),            // 12: Batch Size (clamped 1-16)
    sourceAudio,                                                  // 13: Source Audio (filepath | null)
    params.audioCodes || '',                                      // 14: LM Codes Hints
    params.repaintingStart ?? 0.0,                                // 15: Repainting Start
    params.repaintingEnd ?? -1,                                   // 16: Repainting End
    params.instruction || 'Fill the audio semantic mask with the style described in the text prompt.', // 17: Instruction
    strengthArg18,                                               // 18: LM Codes Strength (also reference inspiration strength for text2music)
    ignoreAudio ? 'text2music' : (params.taskType || 'text2music'), // 19: Task Type
    params.useAdg ?? false,                                       // 20: Use ADG
    params.cfgIntervalStart ?? 0.0,                               // 21: CFG Interval Start
    params.cfgIntervalEnd ?? 1.0,                                 // 22: CFG Interval End
    params.shift ?? 3.0,                                          // 23: Shift
    params.inferMethod || 'ode',                                  // 24: Inference Method
    params.customTimesteps || '',                                 // 25: Custom Timesteps
    params.audioFormat || 'mp3',                                  // 26: Audio Format
    params.lmTemperature ?? 0.85,                                 // 27: LM Temperature
    isThinking,                                                   // 28: Think
    params.lmCfgScale ?? 2.0,                                    // 29: LM CFG Scale
    params.lmTopK ?? 0,                                           // 30: LM Top-K
    params.lmTopP ?? 0.9,                                         // 31: LM Top-P
    params.lmNegativePrompt || 'NO USER INPUT',                   // 32: LM Negative Prompt
    params.lmRepetitionPenalty ?? 1.2,                            // 33: LM Repetition Penalty (1.0 = off, >1.0 = more melodic variation)
    params.noRepeatNgramSize ?? 0,                                // 34: No-Repeat N-gram Size (0 = off, 3 = block 600ms patterns = faster note changes)
    useCot ? (params.useCotMetas ?? true) : false,                // 35: CoT Metas
    useCot ? (params.useCotCaption ?? true) : false,              // 36: CaptionRewrite
    useCot ? (params.useCotLanguage ?? true) : false,             // 37: CoT Language
    params.isFormatCaption ?? false,                              // 38: Is Format Caption State
    params.constrainedDecodingDebug ?? false,                     // 39: Constrained Decoding Debug
    params.allowLmBatch ?? true,                                  // 40: ParallelThinking
    params.getScores ?? false,                                    // 41: Auto Score
    params.getLrc ?? false,                                       // 42: Auto LRC
    params.scoreScale ?? 0.5,                                     // 43: Quality Score Sensitivity
    params.lmBatchChunkSize ?? 8,                                 // 44: LM Batch Chunk Size
    params.trackName || null,                                     // 45: Track Name
    params.completeTrackClasses || [],                            // 46: Track Names
    params.autogen ?? false,                                      // 47: AutoGen
    0,                                                            // 47: Current Batch Index
    1,                                                            // 48: Total Batches
    [],                                                           // 49: Batch Queue
    {},                                                           // 50: Generation Params State
    params.apgNormThreshold ?? 2.5,                                // 51: APG Norm Threshold
    params.apgMomentum ?? -0.75,                                   // 52: APG Momentum
    params.apgEta ?? 0.0,                                          // 53: APG Eta
  ];
}

/**
 * Download a Gradio audio result file to local storage.
 * Gradio returns file objects with { url, path, orig_name, ... }.
 * We copy from the server-local path (same machine) or download via URL.
 */
async function downloadGradioAudioFile(
  fileObj: { url?: string; path?: string; orig_name?: string },
  destPath: string,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });

  // Prefer direct filesystem copy (both servers on same machine)
  if (fileObj.path && existsSync(fileObj.path)) {
    await copyFile(fileObj.path, destPath);
    return;
  }

  // Fall back to HTTP download via Gradio URL (use temp file for atomicity)
  if (fileObj.url) {
    const response = await fetch(fileObj.url);
    if (!response.ok) {
      throw new Error(`Failed to download Gradio audio: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('Downloaded audio file is empty');
    }
    const tmpPath = destPath + '.tmp';
    await writeFile(tmpPath, buffer);
    const { rename } = await import('fs/promises');
    await rename(tmpPath, destPath);
    return;
  }

  throw new Error('Gradio file object has neither path nor url');
}

/**
 * Splice a repainted segment into the ORIGINAL audio to avoid generational loss.
 *
 * Why: on repaint the model keeps the unmasked latents but the WHOLE latent is re-decoded
 * through the VAE, so every repaint pass slightly degrades even the untouched audio.
 * By keeping the original file outside [startSec, endSec] and inserting only the new
 * segment (40 ms equal-power crossfades at the seams), repeated edits no longer degrade
 * the rest of the track.
 *
 * Returns true if the splice succeeded (newPath overwritten with the spliced audio).
 */
function spliceRepaintedAudio(
  originalPath: string,
  newPath: string,
  startSec: number,
  endSec: number,
): boolean {
  try {
    if (!existsSync(originalPath) || !existsSync(newPath)) return false;

    const origDur = getAudioDurationFloat(originalPath);
    const newDur = getAudioDurationFloat(newPath);
    if (origDur <= 0 || newDur <= 0) return false;

    const XF = 0.04; // 40ms crossfade
    const start = Math.max(0, Math.min(startSec, origDur));
    const end = Math.min(endSec <= 0 ? origDur : endSec, origDur, newDur);
    if (end - start < XF * 3) return false; // region too small to splice safely

    const ext = path.extname(newPath);
    const tmpOut = newPath.replace(ext, `.spliced${ext}`);
    const codecArgs = ext === '.flac' ? '-c:a flac' : ext === '.wav' ? '-c:a pcm_s16le' : '-c:a libmp3lame -b:a 320k';

    const hasPre = start > XF;
    const hasPost = end < origDur - XF;

    let filter = '';
    if (hasPre && hasPost) {
      filter =
        `[0:a]atrim=0:${start.toFixed(3)},asetpts=PTS-STARTPTS[pre];` +
        `[1:a]atrim=${Math.max(0, start - XF).toFixed(3)}:${end.toFixed(3)},asetpts=PTS-STARTPTS[mid];` +
        `[0:a]atrim=${Math.max(0, end - XF).toFixed(3)},asetpts=PTS-STARTPTS[post];` +
        `[pre][mid]acrossfade=d=${XF}:c1=tri:c2=tri[pm];` +
        `[pm][post]acrossfade=d=${XF}:c1=tri:c2=tri[out]`;
    } else if (hasPre) {
      filter =
        `[0:a]atrim=0:${start.toFixed(3)},asetpts=PTS-STARTPTS[pre];` +
        `[1:a]atrim=${Math.max(0, start - XF).toFixed(3)},asetpts=PTS-STARTPTS[mid];` +
        `[pre][mid]acrossfade=d=${XF}:c1=tri:c2=tri[out]`;
    } else if (hasPost) {
      filter =
        `[1:a]atrim=0:${end.toFixed(3)},asetpts=PTS-STARTPTS[mid];` +
        `[0:a]atrim=${Math.max(0, end - XF).toFixed(3)},asetpts=PTS-STARTPTS[post];` +
        `[mid][post]acrossfade=d=${XF}:c1=tri:c2=tri[out]`;
    } else {
      return false; // repainting the whole clip — nothing to preserve
    }

    execSync(
      `ffmpeg -y -i "${originalPath}" -i "${newPath}" -filter_complex "${filter}" -map "[out]" ${codecArgs} "${tmpOut}"`,
      { timeout: 120000, stdio: 'pipe' },
    );

    if (!existsSync(tmpOut)) return false;
    execSync(process.platform === 'win32' ? `move /y "${tmpOut}" "${newPath}"` : `mv -f "${tmpOut}" "${newPath}"`, {
      timeout: 10000, stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    });
    return true;
  } catch (e) {
    console.warn('[splice] Failed, keeping full re-decoded audio:', e instanceof Error ? e.message : e);
    return false;
  }
}

// Duration with sub-second precision (getAudioDuration rounds to int)
function getAudioDurationFloat(filePath: string): number {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Generation types & interfaces (unchanged public API)
// ---------------------------------------------------------------------------

export interface GenerationParams {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;

  // Custom Mode
  lyrics: string;
  style: string;
  title: string;

  // Common
  instrumental: boolean;
  vocalLanguage?: string;

  // Music Parameters
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;

  // Generation Settings
  inferenceSteps?: number;
  guidanceScale?: number;
  batchSize?: number;
  randomSeed?: boolean;
  seed?: number;
  thinking?: boolean;
  enhance?: boolean;
  audioFormat?: 'mp3' | 'flac';
  inferMethod?: 'ode' | 'sde';
  shift?: number;

  // LM Parameters
  lmTemperature?: number;
  lmCfgScale?: number;
  lmTopK?: number;
  lmTopP?: number;
  lmNegativePrompt?: string;
  lmBackend?: 'pt' | 'vllm';
  lmModel?: string;

  // Expert Parameters
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  referenceAudioTitle?: string;
  sourceAudioTitle?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  instruction?: string;
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
  sectionMeasures?: number;
  melodicVariation?: number;
  lmRepetitionPenalty?: number;
  noRepeatNgramSize?: number;

  // APG Melodic Variation (base model)
  apgNormThreshold?: number;
  apgMomentum?: number;
  apgEta?: number;

  // LoRA
  loraLoaded?: boolean;
  loraPath?: string;
  loraName?: string;
  loraScale?: number;
  loraEnabled?: boolean;
  loraTriggerTag?: string;
  loraTagPosition?: string;

  // Multi-region repaint: sequential chain, each region with its own overrides
  repaintRegions?: RepaintRegion[];

  // Model selection
  ditModel?: string;
}

export interface RepaintRegion {
  start: number;            // seconds
  end: number;              // seconds
  style?: string;           // per-region prompt override
  lyrics?: string;          // per-region lyrics override
  loraPath?: string;        // per-region LoRA override (falls back to job-level LoRA)
  loraName?: string;
  loraScale?: number;
}

interface GenerationResult {
  audioUrls: string[];
  duration: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  actualSeed?: number;
  status: string;
}

interface JobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queuePosition?: number;
  etaSeconds?: number;
  progress?: number;
  stage?: string;
  result?: GenerationResult;
  error?: string;
}

interface ActiveJob {
  params: GenerationParams;
  startTime: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  taskId?: string;
  result?: GenerationResult;
  error?: string;
  processPromise?: Promise<void>;
  rawResponse?: unknown;
  queuePosition?: number;
  progress?: number;
  stage?: string;
  cancelled?: boolean;
  // Multi-region chain: maps each region's 0-100 progress into its slice of the bar
  progressBase?: number;
  progressScale?: number;
}

const activeJobs = new Map<string, ActiveJob>();

// Periodic cleanup of old jobs (every 10 minutes, remove jobs older than 1 hour)
setInterval(() => cleanupOldJobs(3600000), 600000);

// Job queue for sequential processing (GPU can only handle one job at a time)
const jobQueue: string[] = [];
let isProcessingQueue = false;

// Health check - verify Gradio app is reachable
export async function checkSpaceHealth(): Promise<boolean> {
  return isGradioAvailable();
}

// Backend status — returns DiT + LLM model info from Gradio /v1/status
export interface BackendStatus {
  dit: { loaded: boolean; model: string | null; is_turbo: boolean };
  llm: { loaded: boolean; model: string | null; backend: string | null };
}
export async function getBackendStatus(): Promise<BackendStatus> {
  const resp = await fetch(`${ACESTEP_API}/v1/status`);
  if (!resp.ok) throw new Error(`Backend status failed: ${resp.status}`);
  const json = await resp.json();
  // Unwrap { code, data } envelope used by api_routes.py
  const data = json.data ?? json;
  return data as BackendStatus;
}

// Queue statistics from Python API /v1/stats
export async function getQueueStats() {
  const resp = await fetch(`${ACESTEP_API}/v1/stats`);
  if (!resp.ok) throw new Error(`Queue stats failed: ${resp.status}`);
  const json = await resp.json();
  return json.data ?? json;
}

// Swap LLM model — unloads current, loads new one (blocking ~30-90s)
export interface LlmSwapResult {
  success: boolean;
  message: string;
  model: string | null;
  backend: string | null;
}
export async function swapLlmModel(modelName: string, backend: string = 'pt'): Promise<LlmSwapResult> {
  const resp = await fetch(`${ACESTEP_API}/v1/llm/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, backend }),
  });
  const json = await resp.json();
  const data = json.data ?? json;
  return data as LlmSwapResult;
}

// Discover endpoints (for compatibility)
export async function discoverEndpoints(): Promise<unknown> {
  return { provider: 'acestep-gradio', endpoint: ACESTEP_API };
}

// Reset client — forces Gradio reconnection on next request
export function resetClient(): void {
  resetGradioClient();
}

/**
 * Full server reinitialize — emergency reset.
 * Cancels all jobs, clears queue, resets Gradio client, purges VRAM.
 */
export function reinitializeServer(): { cancelledJobs: number; message: string } {
  let cancelledCount = 0;

  // Cancel all active/queued jobs
  for (const [jobId, job] of activeJobs) {
    if (job.status === 'queued' || job.status === 'running') {
      job.cancelled = true;
      job.status = 'failed';
      job.error = 'Server reinitialized';
      job.stage = 'Cancelled — server reset';
      cancelledCount++;
    }
  }

  // Clear the job queue
  jobQueue.length = 0;
  isProcessingQueue = false;

  // Reset Gradio client (forces fresh reconnection)
  resetGradioClient();

  // Purge VRAM
  autoPurgeVram();

  console.log(`[Reinitialize] Server reset: ${cancelledCount} jobs cancelled, Gradio client reset, VRAM purge triggered`);
  return { cancelledJobs: cancelledCount, message: 'Server reinitialized successfully' };
}

/**
 * Cancel a running or queued generation job.
 * For running jobs: resets the Gradio client (force-interrupts predict) + purges VRAM.
 * For queued jobs: removes from queue immediately.
 */
export function cancelJob(jobId: string): { success: boolean; message: string } {
  const job = activeJobs.get(jobId);
  if (!job) {
    return { success: false, message: 'Job not found' };
  }

  if (job.status === 'succeeded' || job.status === 'failed') {
    return { success: false, message: `Job already ${job.status}` };
  }

  const wasRunning = job.status === 'running';

  // Mark as cancelled
  job.cancelled = true;
  job.status = 'failed';
  job.error = 'Cancelled by user';
  job.stage = 'Cancelled';

  // Remove from queue if queued
  const queueIdx = jobQueue.indexOf(jobId);
  if (queueIdx >= 0) {
    jobQueue.splice(queueIdx, 1);
    // Update queue positions
    jobQueue.forEach((id, index) => {
      const queuedJob = activeJobs.get(id);
      if (queuedJob) queuedJob.queuePosition = index + 1;
    });
  }

  // If was running, abort the Python-side diffusion loop, then reset the client
  if (wasRunning) {
    console.log(`[Cancel] Job ${jobId}: Aborting in-flight generation on Python side`);
    fetch(`${ACESTEP_API}/v1/generation_cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(j => console.log(`[Cancel] Python cancel: ${JSON.stringify(j?.data ?? j)}`))
      .catch(e => console.warn(`[Cancel] Python cancel failed (falling back to client reset): ${e?.message || e}`));
    resetGradioClient();
    // Purge VRAM to clean up residual tensors from interrupted generation
    autoPurgeVram();
  }

  console.log(`[Cancel] Job ${jobId}: ${wasRunning ? 'Running job interrupted' : 'Queued job removed'}`);
  return { success: true, message: wasRunning ? 'Generation interrupted' : 'Job removed from queue' };
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (jobQueue.length > 0) {
      const jobId = jobQueue[0];
      const job = activeJobs.get(jobId);

      if (job && job.status === 'queued') {
        try {
          // Route section jobs to section processor, normal jobs to standard processor
          if (jobId.startsWith('secjob_')) {
            await processSectionGeneration(jobId, job.params, job);
          } else {
            await processGeneration(jobId, job.params, job);
          }
        } catch (error) {
          console.error(`Queue processing error for ${jobId}:`, error);
          // Ensure the job is marked as failed if processGeneration threw
          // Note: job.status may have been mutated inside processGeneration
          const currentStatus = job.status as string;
          if (currentStatus !== 'succeeded' && currentStatus !== 'failed') {
            job.status = 'failed';
            job.error = error instanceof Error ? error.message : 'Unexpected queue error';
          }
        }
      } else if (job && job.status !== 'queued') {
        // Job was cancelled or already processed — skip silently
        console.log(`Queue: Skipping job ${jobId} (status: ${job.status})`);
      }

      // Remove from queue after processing (whether success or failure)
      jobQueue.shift();

      // Update queue positions for remaining jobs
      jobQueue.forEach((id, index) => {
        const queuedJob = activeJobs.get(id);
        if (queuedJob) {
          queuedJob.queuePosition = index + 1;
        }
      });
    }
  } finally {
    // Always reset the flag so the queue can be restarted
    isProcessingQueue = false;
  }
}

// Submit generation job to queue
export async function generateMusicViaAPI(params: GenerationParams): Promise<{ jobId: string }> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const job: ActiveJob = {
    params,
    startTime: Date.now(),
    status: 'queued',
    queuePosition: jobQueue.length + 1,
  };

  activeJobs.set(jobId, job);
  jobQueue.push(jobId);

  console.log(`Job ${jobId}: Queued at position ${job.queuePosition}`);

  // Start processing the queue (will be a no-op if already processing)
  processQueue().catch(err => console.error('Queue processing error:', err));

  return { jobId };
}

// ---------------------------------------------------------------------------
// processGeneration — Gradio primary, Python spawn fallback
// ---------------------------------------------------------------------------

async function processGeneration(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  job.status = 'running';
  job.stage = 'Starting generation...';

  // Guard: cover/audio2audio requires a source or audio codes
  if ((params.taskType === 'cover' || params.taskType === 'audio2audio') && !params.sourceAudioUrl && !params.audioCodes) {
    job.status = 'failed';
    job.error = `task_type='${params.taskType}' requires a source audio or audio codes`;
    return;
  }

  // Try Gradio first
  const gradioUp = await isGradioAvailable();
  if (gradioUp) {
    try {
      // Multi-region repaint: chain one repaint per region, feeding each output
      // into the next. The splice keeps untouched audio bit-perfect throughout.
      if (params.taskType === 'repaint' && params.repaintRegions && params.repaintRegions.length > 1) {
        await processMultiRegionRepaint(jobId, params, job);
      } else {
        await processGenerationViaGradio(jobId, params, job);
      }
      autoPurgeVram();
      return;
    } catch (error) {
      // A cancelled job must not respawn via the Python fallback
      if (job.cancelled) {
        console.log(`Job ${jobId}: cancelled — skipping Python fallback`);
        autoPurgeVram();
        return;
      }
      console.error(`Job ${jobId}: Gradio generation failed, trying Python spawn fallback`, error);
      // Reset client so next call reconnects (connection may be broken)
      resetGradioClient();
      autoPurgeVram();
      // Fall through to Python spawn
    }
  }

  // Fallback: Python spawn
  await processGenerationViaPython(jobId, params, job);
  autoPurgeVram();
}

/**
 * Multi-region repaint. Two strategies:
 *  • SINGLE-PASS (all regions share the job's prompt/lyrics/LoRA): one diffusion over the
 *    min→max span, then per-region splice — new audio inside each selection, the ORIGINAL
 *    everywhere else (including the gaps between selections). N× faster than chaining.
 *  • CHAIN (any region has its own prompt/lyrics/LoRA): one repaint per region, feeding
 *    each spliced output into the next.
 */
async function processMultiRegionRepaint(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  const regions = [...(params.repaintRegions || [])]
    .filter(r => isFinite(r.start) && isFinite(r.end) && r.end - r.start >= 0.15)
    .sort((a, b) => a.start - b.start);
  if (regions.length === 0) throw new Error('No valid repaint regions');

  const n = regions.length;
  const uniform = regions.every(r =>
    (!r.style || !r.style.trim()) && r.lyrics === undefined && r.loraPath === undefined
  );

  if (uniform) {
    // ── SINGLE-PASS ──
    job.stage = `Secciones 1-${n} (una pasada)…`;
    const spanStart = regions[0].start;
    const spanEnd = regions[n - 1].end;
    const regionParams = {
      ...params,
      repaintRegions: undefined,
      repaintingStart: spanStart,
      repaintingEnd: spanEnd,
      _skipSplice: true,   // caller splices per-region below
      _deferSuccess: true, // job must stay 'running' until the splice finishes
    } as GenerationParams;

    await processGenerationViaGradio(jobId, regionParams, job);
    if (job.status === 'failed' || job.cancelled) return;
    if (!job.result?.audioUrls?.length) throw new Error('Single-pass repaint produced no audio');

    // Per-region splice: iterate keeping `acc` = original-so-far, pulling each region
    // from a fresh copy of the RAW generated file (the splice overwrites its 2nd input).
    const rawUrl = job.result.audioUrls[0];
    const rawPath = resolveAudioPath(rawUrl);
    const srcPath = resolveAudioPath(params.sourceAudioUrl!);
    const ext = path.extname(rawPath);
    let accPath = srcPath;
    let spliceOk = true;
    for (let i = 0; i < n; i++) {
      const stepPath = rawPath.replace(ext, `.acc${i}${ext}`);
      await copyFile(rawPath, stepPath);
      const ok = spliceRepaintedAudio(accPath, stepPath, regions[i].start, regions[i].end);
      if (!ok) {
        console.warn(`Job ${jobId}: per-region splice failed at region ${i + 1}/${n} — keeping full union repaint`);
        await rm(stepPath).catch(() => {});
        spliceOk = false;
        break;
      }
      if (accPath !== srcPath) await rm(accPath).catch(() => {});
      accPath = stepPath;
    }
    if (spliceOk && accPath !== srcPath) {
      await copyFile(accPath, rawPath);
      await rm(accPath).catch(() => {});
    }
    job.progress = 100;
    job.status = 'succeeded';
    console.log(`Job ${jobId}: single-pass multi-repaint completed (${n} regions, splice=${spliceOk ? 'per-region' : 'union-fallback'})`);
    return;
  }

  // ── CHAIN ──
  let currentSourceUrl = params.sourceAudioUrl!;
  let lastResult: GenerationResult | null = null;

  for (let i = 0; i < n; i++) {
    if (job.cancelled) {
      console.log(`Job ${jobId}: multi-repaint cancelled at region ${i + 1}/${n}`);
      return;
    }
    const r = regions[i];
    job.stage = `Sección ${i + 1}/${n}…`;
    // Scale each region's 0-100 progress into its slice of the overall bar
    job.progressBase = Math.round((i / n) * 100);
    job.progressScale = 1 / n;

    const regionParams = {
      ...params,
      repaintRegions: undefined,
      sourceAudioUrl: currentSourceUrl,
      repaintingStart: r.start,
      repaintingEnd: r.end,
      style: r.style?.trim() ? r.style.trim() : params.style,
      lyrics: r.lyrics !== undefined ? r.lyrics : params.lyrics,
      // Per-region LoRA override (job-level LoRA used when not specified)
      ...(r.loraPath !== undefined ? {
        loraPath: r.loraPath,
        loraName: r.loraName,
        loraScale: r.loraScale ?? params.loraScale,
        loraEnabled: !!r.loraPath,
        loraLoaded: !!r.loraPath,
      } : {}),
      // Links after the first reuse the already-loaded model+LoRA (unless overridden)
      ...(i > 0 && r.loraPath === undefined ? { _skipModelLoraSetup: true } : {}),
      // Intermediate links must never look 'succeeded' to pollers
      _deferSuccess: true,
      // Distinct seed per region unless the user pinned one
      seed: params.randomSeed === false && typeof params.seed === 'number' ? params.seed + i : undefined,
      randomSeed: params.randomSeed !== false,
    } as GenerationParams;

    // Unique sub-id per region → unique output filenames (iteration N must never
    // overwrite iteration N-1's file, which is its own splice source)
    await processGenerationViaGradio(`${jobId}~r${i + 1}`, regionParams, job);

    if (job.status === 'failed' || job.cancelled) return;
    if (!job.result?.audioUrls?.length) throw new Error(`Region ${i + 1}/${n} produced no audio`);

    lastResult = job.result;
    currentSourceUrl = job.result.audioUrls[0];
    // Status stays 'running' throughout (links defer success); final flip happens below
  }

  job.progressBase = undefined;
  job.progressScale = undefined;
  job.progress = 100;
  job.status = 'succeeded';
  if (lastResult) job.result = lastResult;
  console.log(`Job ${jobId}: multi-repaint completed (${n} regions)`);
}

async function processGenerationViaGradio(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  const client = await getGradioClient();
  const args = await buildGradioArgs(params);

  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);

  console.log(`Job ${jobId}: Using Gradio /generation_wrapper`, {
    prompt: prompt.slice(0, 50),
    duration: params.duration,
    batchSize: params.batchSize,
  });

  // ---------------------------------------------------------------------------
  // Ensure the correct DiT model + LoRA are actually loaded BEFORE generating.
  // /generation_wrapper always uses whatever model + LoRA are currently loaded
  // server-side, so we must reconcile that state here:
  //   • Swapping the model RE-INITIALIZES it and DISCARDS any loaded LoRA, so
  //     the LoRA must be (re)loaded AFTER the swap — otherwise the adapter the
  //     user selected is silently dropped and the audio sounds wrong.
  //   • We only swap / reload when the desired state differs from the current
  //     one, to avoid a full (slow) model reload on every generation.
  // ---------------------------------------------------------------------------
  job.stage = 'Preparing model & LoRA...';

  // Chain links after the first reuse the exact model+LoRA state — skip the
  // status/reload round-trip (it costs ~10s per link and can re-wrap the decoder)
  const skipSetup = (params as GenerationParams & { _skipModelLoraSetup?: boolean })._skipModelLoraSetup === true;

  // 1) Read the current server-side model + LoRA state.
  let curModel = '';
  let curLoraLoaded = false;
  let curLoraPath = '';
  let statusOk = false;
  if (!skipSetup) try {
    const st = await client.predict('/get_lora_status', []);
    const s = ((st.data as unknown[])[0] || {}) as Record<string, unknown>;
    curModel = (s.model_name as string) || '';
    curLoraLoaded = !!s.loaded;
    curLoraPath = (s.path as string) || '';
    statusOk = true;
  } catch (e) {
    console.warn(`Job ${jobId}: could not read model/LoRA status`, e instanceof Error ? e.message : e);
  }

  // 2) Swap the DiT model only when it differs from the one already loaded.
  //    Only act when we actually READ the current state — never swap on an unknown
  //    (failed) status read, which would tear the model down for no reason.
  let modelSwapped = false;
  if (statusOk && params.ditModel && params.ditModel !== curModel) {
    try {
      const loadResp = await fetch(`${ACESTEP_API}/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: params.ditModel }),
      });
      const loadJson = await loadResp.json().catch(() => null) as { code?: number; error?: string; detail?: string } | null;
      if (!loadResp.ok || (loadJson && loadJson.code && loadJson.code !== 200)) {
        const detail = (loadJson && (loadJson.error || loadJson.detail)) || `HTTP ${loadResp.status}`;
        job.status = 'failed';
        job.error = `No se pudo cargar el modelo DiT '${params.ditModel}': ${detail}. ` +
          `Verifica que el checkpoint existe en checkpoints/ y está descargado.`;
        console.error(`Job ${jobId}: ${job.error}`);
        return;
      }
      modelSwapped = true;
      // Swapping the model wipes any previously loaded LoRA on the server.
      curLoraLoaded = false;
      curLoraPath = '';
      console.log(`Job ${jobId}: DiT model loaded → ${params.ditModel}`);
    } catch (e) {
      job.status = 'failed';
      job.error = `Error al cargar el modelo DiT '${params.ditModel}': ${e instanceof Error ? e.message : String(e)}`;
      console.error(`Job ${jobId}: ${job.error}`);
      return;
    }
  }

  // 3) (Re)apply the LoRA AFTER the model is in place.
  const wantLora = !skipSetup && params.loraEnabled !== false && !!params.loraPath;
  if (wantLora) {
    // Robustly decide whether the desired LoRA is ALREADY loaded server-side.
    // The backend reports an OS-normalized ABSOLUTE path (Windows backslashes),
    // while the frontend sends a relative/forward-slash path — a naive string
    // compare (curLoraPath !== params.loraPath) is ALWAYS true on Windows, which
    // made us tear down + deep-copy + re-wrap the whole decoder on EVERY
    // generation. That heavy per-gen model surgery churns VRAM and can make
    // successive generations progressively worse.
    // Compare on a canonical form (forward slashes, lowercase). For the
    // absolute-vs-relative case, require one FULL path to be a trailing sub-path of the
    // other — NOT just a basename match, because different LoRAs commonly save their
    // checkpoint folder as "epoch_400" and a basename compare would treat two different
    // LoRAs as identical and silently refuse to switch between them.
    const normPath = (p?: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const sameLora = (a?: string, b?: string) => {
      const na = normPath(a), nb = normPath(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      const shorter = na.length <= nb.length ? na : nb;
      const longer = na.length <= nb.length ? nb : na;
      // Only a multi-segment trailing match counts (e.g. ".../walki_86_sft/checkpoints/epoch_400").
      return shorter.includes('/') && longer.endsWith('/' + shorter);
    };
    const alreadyLoaded = curLoraLoaded && sameLora(curLoraPath, params.loraPath);
    const needsLoad = modelSwapped || (statusOk && !alreadyLoaded);
    if (needsLoad) {
      try {
        const lr = await client.predict('/load_lora', [params.loraPath]);
        console.log(`Job ${jobId}: LoRA loaded → ${(lr.data as unknown[])[0]}`);
      } catch (e) {
        job.status = 'failed';
        job.error = `No se pudo cargar el LoRA '${params.loraName || params.loraPath}': ${e instanceof Error ? e.message : String(e)}`;
        console.error(`Job ${jobId}: ${job.error}`);
        return;
      }
    }
    const scale = typeof params.loraScale === 'number' ? params.loraScale : 1.0;
    await client.predict('/set_lora_scale', [scale]).catch(() => {});
  } else if (!skipSetup && statusOk && curLoraLoaded) {
    // This job does NOT request a LoRA but one is still active server-side
    // (e.g. auto-loaded by a previous repaint). Neutralize it so plain
    // generations never silently inherit a leftover adapter. A later job that
    // DOES request it just re-raises the scale — no reload cost.
    console.log(`Job ${jobId}: neutralizing leftover LoRA (${curLoraPath || 'unknown path'}) — job requests none`);
    await client.predict('/set_lora_scale', [0]).catch(() => {});
  }

  // 4) Verification: read back the REAL state so the log reflects exactly what
  //    this generation will use (model + LoRA + key inference params).
  try {
    const st2 = await client.predict('/get_lora_status', []);
    const s2 = ((st2.data as unknown[])[0] || {}) as Record<string, unknown>;
    console.log(
      `Job ${jobId}: [verify] model=${s2.model_name || curModel || 'default'} | ` +
      `lora=${s2.loaded ? `${s2.name || s2.path} (active=${s2.active}, scale=${s2.scale})` : 'none'} | ` +
      `steps=${params.inferenceSteps ?? 8} guidance=${params.guidanceScale ?? 7} shift=${params.shift ?? 3}`,
    );
  } catch {
    /* verification logging only — never block generation */
  }

  job.stage = 'Generating audio…';
  job.progress = job.progressBase ?? 0;

  // Poll the REAL diffusion-step progress from the Gradio side while predict() blocks.
  // We use predict() (not submit()) because submit() streaming a GENERATOR was dropping
  // the audio: generation_wrapper yields several payloads and the LAST one is a UI-reset
  // with the audio outputs cleared. predict() reliably returns the final audio result.
  let pollActive = true;
  const progressTimer = setInterval(() => {
    fetch(`${ACESTEP_API}/v1/generation_status`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then((j: { data?: { progress?: number; active?: boolean } } | null) => {
        const p = j?.data?.progress;
        // Only trust the % while diffusion is actually running — between phases the
        // tracker may hold a stale value from the previous generation
        if (pollActive && j?.data?.active === true && typeof p === 'number') {
          const scaled = job.progressScale !== undefined
            ? Math.round((job.progressBase ?? 0) + p * job.progressScale)
            : p;
          job.progress = Math.min(99, Math.max(job.progressBase ?? 0, scaled));
        }
      })
      .catch(() => {});
  }, 600);

  let result: { data?: unknown[] };
  try {
    result = await client.predict('/generation_wrapper', args) as { data?: unknown[] };
  } finally {
    pollActive = false;
    clearInterval(progressTimer);
  }

  const data = result.data as unknown[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Gradio returned unexpected data format: ${typeof data}`);
  }

  // Extract audio files from the result
  // Outputs 0-7: individual audio samples (filepath objects)
  // Output 8: "All Generated Files" as list[filepath]
  // Output 9: "Generation Details" (string)
  // Output 10: "Generation Status" (string)
  // Output 11: "Seed" (string)
  const allFiles = data[8]; // list of file objects
  const genDetails = data[9] as string | undefined;
  const genStatus = data[10] as string | undefined;
  const seedOutput = data[11] as string | number | undefined;

  // Collect audio file objects — prefer the "All Generated Files" list
  let audioFileObjects: Array<{ url?: string; path?: string; orig_name?: string }> = [];

  if (Array.isArray(allFiles) && allFiles.length > 0) {
    audioFileObjects = allFiles.filter(
      (f: any) => f && (f.path || f.url) && isAudioFile(f.orig_name || f.path || '')
    );
  }

  // Fallback: check individual sample outputs (indices 0-7)
  if (audioFileObjects.length === 0) {
    for (let i = 0; i < 8; i++) {
      const fileObj = data[i] as any;
      if (fileObj && (fileObj.path || fileObj.url)) {
        audioFileObjects.push(fileObj);
      }
    }
  }

  if (audioFileObjects.length === 0) {
    throw new Error(`Gradio generation returned no audio files. Status: ${genStatus || 'unknown'}. Details: ${genDetails || 'none'}`);
  }

  // Download audio files to local storage
  const audioUrls: string[] = [];
  let actualDuration = 0;
  const audioFormat = params.audioFormat ?? 'mp3';

  for (const fileObj of audioFileObjects) {
    const origName = fileObj.orig_name || fileObj.path || '';
    const ext = origName.includes('.flac') ? '.flac' : `.${audioFormat}`;
    const filename = `${jobId}_${audioUrls.length}${ext}`;
    const destPath = path.join(AUDIO_DIR, filename);

    await downloadGradioAudioFile(fileObj, destPath);

    // Repaint: preserve the original audio outside the edited region (anti-degradation).
    // Skipped in single-pass multi-region mode — the caller does a per-region splice.
    if (
      params.taskType === 'repaint' &&
      !(params as GenerationParams & { _skipSplice?: boolean })._skipSplice &&
      params.sourceAudioUrl &&
      typeof params.repaintingStart === 'number' &&
      typeof params.repaintingEnd === 'number' &&
      params.repaintingEnd > params.repaintingStart
    ) {
      const srcPath = resolveAudioPath(params.sourceAudioUrl);
      const ok = spliceRepaintedAudio(srcPath, destPath, params.repaintingStart, params.repaintingEnd);
      console.log(`Job ${jobId}: repaint splice ${ok ? 'applied' : 'skipped'} (${params.repaintingStart}s–${params.repaintingEnd}s)`);
    }

    if (audioUrls.length === 0) {
      actualDuration = getAudioDuration(destPath);
    }

    audioUrls.push(`/audio/${filename}`);
  }

  // Parse metadata from generation details if available
  const metas = parseGenerationDetails(genDetails);

  const finalDuration = actualDuration > 0
    ? actualDuration
    : (metas.duration || params.duration || 60);

  // Parse actual seed from Gradio output
  let actualSeed: number | undefined;
  if (seedOutput !== undefined && seedOutput !== null) {
    const parsed = typeof seedOutput === 'number' ? seedOutput : parseInt(String(seedOutput), 10);
    if (!isNaN(parsed)) actualSeed = parsed;
  }

  // Orchestrated multi-region flows finish the job themselves AFTER splicing —
  // flipping to 'succeeded' here would let pollers download the raw un-spliced file.
  const deferSuccess = (params as GenerationParams & { _deferSuccess?: boolean })._deferSuccess === true;
  job.status = deferSuccess ? 'running' : 'succeeded';
  job.result = {
    audioUrls,
    duration: finalDuration,
    bpm: metas.bpm || params.bpm,
    keyScale: metas.keyScale || params.keyScale,
    timeSignature: metas.timeSignature || params.timeSignature,
    actualSeed,
    status: 'succeeded',
  };
  job.rawResponse = { genDetails, genStatus, seedOutput };
  console.log(`Job ${jobId}: Completed via Gradio with ${audioUrls.length} audio files`);
}

function isAudioFile(name: string): boolean {
  return /\.(mp3|flac|wav|ogg|m4a)$/i.test(name);
}

function parseGenerationDetails(details: string | undefined): {
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
} {
  if (!details) return {};
  try {
    // Generation details may contain key-value pairs
    const bpmMatch = details.match(/BPM:\s*(\d+)/i);
    const durationMatch = details.match(/Duration:\s*([\d.]+)/i);
    const keyMatch = details.match(/Key:\s*([A-G][#b]?\s*(?:major|minor))/i);
    const timeMatch = details.match(/Time Signature:\s*(\d+\/\d+)/i);
    return {
      bpm: bpmMatch ? parseInt(bpmMatch[1]) : undefined,
      duration: durationMatch ? parseFloat(durationMatch[1]) : undefined,
      keyScale: keyMatch ? keyMatch[1] : undefined,
      timeSignature: timeMatch ? timeMatch[1] : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Python spawn fallback (kept from original for offline/fallback use)
// ---------------------------------------------------------------------------

async function processGenerationViaPython(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');

  console.log(`Job ${jobId}: Using Python spawn (Gradio not available)`, {
    prompt: prompt.slice(0, 50),
    lyricsPreview: lyrics.slice(0, 50),
    duration: params.duration,
    batchSize: params.batchSize,
  });

  try {
    const jobOutputDir = path.join(ACESTEP_DIR, 'output', jobId);
    await mkdir(jobOutputDir, { recursive: true });

    const durationToSend = params.duration && params.duration > 0 ? params.duration : 60;
    const args = [
      '--prompt', prompt,
      '--duration', String(durationToSend),
      '--batch-size', String(params.batchSize ?? 1),
      '--infer-steps', String(params.inferenceSteps ?? 8),
      '--guidance-scale', String(params.guidanceScale ?? 10.0),
      '--audio-format', params.audioFormat ?? 'mp3',
      '--output-dir', jobOutputDir,
      '--json',
    ];

    if (lyrics) args.push('--lyrics', lyrics);
    if (params.instrumental) args.push('--instrumental');
    if (params.bpm && params.bpm > 0) args.push('--bpm', String(params.bpm));
    if (params.keyScale) args.push('--key-scale', params.keyScale);
    if (params.timeSignature) args.push('--time-signature', params.timeSignature);
    if (params.vocalLanguage) args.push('--vocal-language', params.vocalLanguage);
    if (params.seed !== undefined && params.seed >= 0 && !params.randomSeed) args.push('--seed', String(params.seed));
    if (params.shift !== undefined) args.push('--shift', String(params.shift));
    if (params.taskType && params.taskType !== 'text2music') args.push('--task-type', params.taskType);

    if (params.referenceAudioUrl) {
      args.push('--reference-audio', resolveAudioPath(params.referenceAudioUrl));
    }
    if (params.sourceAudioUrl) {
      args.push('--src-audio', resolveAudioPath(params.sourceAudioUrl));
    }
    if (params.audioCodes) args.push('--audio-codes', params.audioCodes);
    if (params.repaintingStart !== undefined && params.repaintingStart > 0) args.push('--repainting-start', String(params.repaintingStart));
    if (params.repaintingEnd !== undefined && params.repaintingEnd > 0) args.push('--repainting-end', String(params.repaintingEnd));
    if (params.taskType === 'cover' || params.taskType === 'repaint' || params.sourceAudioUrl || params.referenceAudioUrl) {
      args.push('--audio-cover-strength', String(params.audioCoverStrength ?? 1.0));
    } else if (params.audioCoverStrength !== undefined && params.audioCoverStrength !== 1.0) {
      args.push('--audio-cover-strength', String(params.audioCoverStrength));
    }
    if (params.instruction) args.push('--instruction', params.instruction);
    if (params.thinking) args.push('--thinking');
    if (params.lmTemperature !== undefined) args.push('--lm-temperature', String(params.lmTemperature));
    if (params.lmCfgScale !== undefined) args.push('--lm-cfg-scale', String(params.lmCfgScale));
    if (params.lmTopK !== undefined && params.lmTopK > 0) args.push('--lm-top-k', String(params.lmTopK));
    if (params.lmTopP !== undefined) args.push('--lm-top-p', String(params.lmTopP));
    if (params.lmNegativePrompt) args.push('--lm-negative-prompt', params.lmNegativePrompt);
    // Note: --lm-backend and --lm-model are not supported by simple_generate.py
    if (params.useCotMetas === false) args.push('--no-cot-metas');
    if (params.useCotCaption === false) args.push('--no-cot-caption');
    if (params.useCotLanguage === false) args.push('--no-cot-language');
    if (params.useAdg) args.push('--use-adg');
    if (params.cfgIntervalStart !== undefined && params.cfgIntervalStart > 0) args.push('--cfg-interval-start', String(params.cfgIntervalStart));
    if (params.cfgIntervalEnd !== undefined && params.cfgIntervalEnd < 1.0) args.push('--cfg-interval-end', String(params.cfgIntervalEnd));

    const result = await runPythonGeneration(args);

    if (!result.success) {
      throw new Error(result.error || 'Generation failed');
    }

    if (!result.audio_paths || result.audio_paths.length === 0) {
      throw new Error('No audio files generated');
    }

    const audioUrls: string[] = [];
    let actualDuration = 0;
    for (const srcPath of result.audio_paths) {
      const ext = srcPath.includes('.flac') ? '.flac' : '.mp3';
      const filename = `${jobId}_${audioUrls.length}${ext}`;
      const destPath = path.join(AUDIO_DIR, filename);

      await mkdir(AUDIO_DIR, { recursive: true });
      await copyFile(srcPath, destPath);

      if (audioUrls.length === 0) {
        actualDuration = getAudioDuration(destPath);
      }

      audioUrls.push(`/audio/${filename}`);
    }

    try {
      await rm(jobOutputDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`Job ${jobId}: Failed to cleanup output dir`, cleanupError);
    }

    const finalDuration = actualDuration > 0 ? actualDuration : (params.duration && params.duration > 0 ? params.duration : 60);

    // Extract actual seed from Python result if available
    let actualSeed: number | undefined;
    if (result.seed !== undefined) {
      const parsed = typeof result.seed === 'number' ? result.seed : parseInt(String(result.seed), 10);
      if (!isNaN(parsed)) actualSeed = parsed;
    } else if (!params.randomSeed && params.seed !== undefined && params.seed >= 0) {
      actualSeed = params.seed; // User specified a seed, use it
    }

    job.status = 'succeeded';
    job.result = {
      audioUrls,
      duration: finalDuration,
      bpm: params.bpm,
      keyScale: params.keyScale,
      timeSignature: params.timeSignature,
      actualSeed,
      status: 'succeeded',
    };
    job.rawResponse = result;
    console.log(`Job ${jobId}: Completed via Python in ${result.elapsed_seconds?.toFixed(1)}s with ${audioUrls.length} audio files`);

  } catch (error) {
    console.error(`Job ${jobId}: Generation failed`, error);
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Generation failed';

    try {
      const jobOutputDir = path.join(ACESTEP_DIR, 'output', jobId);
      await rm(jobOutputDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

interface PythonResult {
  success: boolean;
  audio_paths?: string[];
  elapsed_seconds?: number;
  seed?: number;
  error?: string;
}

function runPythonGeneration(scriptArgs: string[], timeoutMs = 600000): Promise<PythonResult> {
  return new Promise((resolve) => {
    const pythonPath = resolvePythonPath(ACESTEP_DIR);
    const args = [PYTHON_SCRIPT, ...scriptArgs];

    const proc = spawn(pythonPath, args, {
      cwd: ACESTEP_DIR,
      env: {
        ...process.env,
        ACESTEP_PATH: ACESTEP_DIR,
      },
    });

    // Kill process after timeout (default 10 minutes)
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      resolve({ success: false, error: `Generation timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[ACE-Step] ${line}`);
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
        return;
      }

      const lines = stdout.split('\n').filter(l => l.trim());
      const jsonLine = lines.find(l => l.startsWith('{'));

      if (!jsonLine) {
        resolve({ success: false, error: 'No JSON output from generation script' });
        return;
      }

      try {
        const result = JSON.parse(jsonLine);
        resolve(result);
      } catch {
        resolve({ success: false, error: 'Invalid JSON from generation script' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Job status (simplified — no more REST polling for progress)
// ---------------------------------------------------------------------------

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const job = activeJobs.get(jobId);

  if (!job) {
    return {
      status: 'failed',
      error: 'Job not found',
    };
  }

  if (job.status === 'succeeded' && job.result) {
    return {
      status: 'succeeded',
      result: job.result,
    };
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      error: job.error || 'Generation failed',
    };
  }

  const elapsed = Math.floor((Date.now() - job.startTime) / 1000);

  if (job.status === 'queued') {
    return {
      status: job.status,
      queuePosition: job.queuePosition,
      etaSeconds: (job.queuePosition || 1) * 180,
    };
  }

  // Running — Gradio handles its own queue, we just report estimated time
  return {
    status: job.status,
    etaSeconds: Math.max(0, 180 - elapsed),
    progress: job.progress,
    stage: job.stage,
  };
}

// Get raw response for debugging
export function getJobRawResponse(jobId: string): unknown | null {
  const job = activeJobs.get(jobId);
  return job?.rawResponse || null;
}

// ---------------------------------------------------------------------------
// Audio helpers (unchanged)
// ---------------------------------------------------------------------------

export async function getAudioStream(audioPath: string): Promise<Response> {
  if (audioPath.startsWith('http')) {
    return fetch(audioPath);
  }

  if (audioPath.startsWith('/audio/')) {
    const localPath = path.join(AUDIO_DIR, audioPath.replace('/audio/', ''));
    try {
      const buffer = await readFile(localPath);
      const ext = localPath.endsWith('.flac') ? 'flac' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch (err) {
      console.error('Failed to read local audio file:', localPath, err);
      return new Response(null, { status: 404 });
    }
  }

  // Absolute path — try reading directly from disk (Gradio output files)
  if (audioPath.startsWith('/')) {
    try {
      const buffer = await readFile(audioPath);
      const ext = audioPath.endsWith('.flac') ? 'flac' : audioPath.endsWith('.wav') ? 'wav' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch {
      // Fall through to Gradio API
    }
  }

  const url = `${ACESTEP_API}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  console.log('Fetching audio from:', url);
  return fetch(url);
}

export async function downloadAudio(remoteUrl: string, songId: string): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true });

  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const ext = remoteUrl.includes('.flac') ? '.flac' : '.mp3';
  const filename = `${songId}${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);

  await writeFile(filepath, Buffer.from(buffer));
  console.log(`Downloaded audio to ${filepath}`);

  return `/audio/${filename}`;
}

export async function downloadAudioToBuffer(remoteUrl: string): Promise<{ buffer: Buffer; size: number }> {
  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return { buffer, size: buffer.length };
}

// ---------------------------------------------------------------------------
// Section-based "Suno-style" generation
// ---------------------------------------------------------------------------

export async function generateSectionsViaAPI(params: GenerationParams): Promise<{ jobId: string }> {
  const jobId = `secjob_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const job: ActiveJob = {
    params,
    startTime: Date.now(),
    status: 'queued',
    queuePosition: jobQueue.length + 1,
  };

  activeJobs.set(jobId, job);
  jobQueue.push(jobId);

  console.log(`Section Job ${jobId}: Queued at position ${job.queuePosition}`);

  // Override processGeneration for this job — the queue will call processGeneration,
  // but we need to intercept it. We do this by replacing the job's params with a marker.
  // Instead, we hook into the queue by using a custom processor.
  // Simpler approach: just push to queue and let processQueue handle it.
  // We detect section jobs in processGeneration by checking the jobId prefix.
  processQueue().catch(err => console.error('Queue processing error:', err));

  return { jobId };
}

/**
 * Process a section-based generation job.
 * Generates each section sequentially, extending the audio each time.
 */
async function processSectionGeneration(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  job.status = 'running';
  job.stage = 'Planning sections...';

  const lyrics = params.lyrics || '';
  const bpm = (params.bpm && params.bpm > 0) ? params.bpm : 120;
  const timeSignature = params.timeSignature || '4';
  const targetDuration = (params.duration && params.duration > 0) ? params.duration : undefined;

  // Plan sections from lyrics to calculate optimal total duration
  const sectionMeasures = params.sectionMeasures && params.sectionMeasures > 0 ? params.sectionMeasures : undefined;
  const plan = planSections(lyrics, bpm, timeSignature, targetDuration, sectionMeasures);

  console.log(`Section Job ${jobId}: Planned ${plan.sections.length} sections, total ~${plan.totalDuration}s`);
  for (const s of plan.sections) {
    console.log(`  [${s.tag}] ${s.lineCount} lines, ~${s.estimatedDuration}s (start: ${s.startTime}s)`);
  }

  // Single-pass generation: ACE-Step natively understands [Verse], [Chorus], etc.
  // We use the section planner ONLY to calculate the optimal duration so the model
  // has enough time for all sections. The full structured lyrics are passed as-is.
  // This avoids: quality degradation from repeated VAE encoding, silence gaps at
  // boundaries, and the complexity of chaining multiple repaint calls.
  const sectionParams: GenerationParams = {
    ...params,
    lyrics: lyrics, // Full structured lyrics with [Verse], [Chorus] tags
    duration: plan.totalDuration, // Calculated duration to fit all sections
    batchSize: 1,
    alignToMeasures: true,
  };

  console.log(`Section Job ${jobId}: Single-pass generation with calculated duration=${plan.totalDuration}s (BPM=${bpm}, sections=${plan.sections.length})`);

  // Delegate to the normal generation pipeline with the optimized duration
  await processGeneration(jobId, sectionParams, job);
}

export function cleanupJob(jobId: string): void {
  activeJobs.delete(jobId);
}

export function cleanupOldJobs(maxAgeMs: number = 3600000): void {
  const now = Date.now();
  for (const [jobId, job] of activeJobs) {
    if (now - job.startTime > maxAgeMs) {
      activeJobs.delete(jobId);
    }
  }
}

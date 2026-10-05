// One-off importer: places a Gradio temp result (.mp3 + .json) into the workspace
// as a proper song record (audio copied into public/audio + row in `songs`).
//
// Usage:  node _import_song.mjs "<gradio_results_dir>" [username]
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = process.argv[2] || 'C:\\Users\\Walki-bass\\AppData\\Local\\Temp\\tmp2tyesdp6acestep_gradio_results';
const USERNAME = process.argv[3] || 'Walki-bass';

const db = new Database(path.join(__dirname, 'data/acestep.db'));
db.pragma('busy_timeout = 8000');

// --- resolve user -----------------------------------------------------------
const user = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(USERNAME)
  || db.prepare('SELECT id, username FROM users ORDER BY created_at LIMIT 1').get();
if (!user) { console.error('No users found in the database.'); process.exit(1); }

// --- find the mp3 + json pair ----------------------------------------------
if (!fs.existsSync(SRC_DIR)) { console.error('Source dir not found:', SRC_DIR); process.exit(1); }
const files = fs.readdirSync(SRC_DIR);
const mp3Name = files.find(f => /\.(mp3|flac|wav)$/i.test(f));
if (!mp3Name) { console.error('No audio file found in', SRC_DIR); process.exit(1); }
const jsonName = files.find(f => /\.json$/i.test(f));
const srcAudio = path.join(SRC_DIR, mp3Name);
const meta = jsonName ? JSON.parse(fs.readFileSync(path.join(SRC_DIR, jsonName), 'utf8')) : {};

// --- copy audio into storage: public/audio/<userId>/<songId>.<ext> ----------
const ext = path.extname(mp3Name).toLowerCase() || '.mp3';
const songId = randomUUID();
const storageKey = `${user.id}/${songId}${ext}`;
const destPath = path.join(__dirname, 'public', 'audio', storageKey);
fs.mkdirSync(path.dirname(destPath), { recursive: true });
fs.copyFileSync(srcAudio, destPath);
const audioUrl = `/audio/${storageKey}`;

// --- map Gradio params (snake_case) -> frontend GenerationParams (camelCase) -
const caption = meta.caption || '';
const lyrics = meta.lyrics || '';
const firstLyric = (lyrics.split('\n').map(s => s.trim()).find(Boolean)) || '';
const title = firstLyric ? firstLyric.slice(0, 60) : (caption.split(',')[0] || 'Imported song').trim();

const generationParams = {
  customMode: true,
  style: caption,
  lyrics,
  title,
  instrumental: !!meta.instrumental,
  vocalLanguage: meta.vocal_language || 'en',
  bpm: meta.bpm ?? 0,
  keyScale: meta.keyscale || '',
  timeSignature: meta.timesignature || '',
  duration: meta.duration ?? -1,
  inferenceSteps: meta.inference_steps ?? 60,
  guidanceScale: meta.guidance_scale ?? 7,
  seed: meta.seed,
  randomSeed: false,
  thinking: !!meta.thinking,
  inferMethod: meta.infer_method || 'ode',
  shift: meta.shift ?? 3,
  taskType: meta.task_type || 'text2music',
  useAdg: !!meta.use_adg,
  cfgIntervalStart: meta.cfg_interval_start ?? 0,
  cfgIntervalEnd: meta.cfg_interval_end ?? 1,
  apgNormThreshold: meta.apg_norm_threshold ?? 2.5,
  apgMomentum: meta.apg_momentum ?? -0.75,
  apgEta: meta.apg_eta ?? 0,
  audioCoverStrength: meta.audio_cover_strength ?? 1,
  repaintingStart: meta.repainting_start ?? 0,
  repaintingEnd: meta.repainting_end ?? -1,
  lmTemperature: meta.lm_temperature,
  lmCfgScale: meta.lm_cfg_scale,
  lmTopK: meta.lm_top_k,
  lmTopP: meta.lm_top_p,
  lmNegativePrompt: meta.lm_negative_prompt,
  lmRepetitionPenalty: meta.lm_repetition_penalty,
  noRepeatNgramSize: meta.lm_no_repeat_ngram_size ?? 0,
};

// --- insert the song --------------------------------------------------------
db.prepare(`
  INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                     duration, bpm, key_scale, time_signature, tags, is_public,
                     generation_params, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
`).run(
  songId,
  user.id,
  title,
  meta.instrumental ? '[Instrumental]' : lyrics,
  caption,
  caption,
  audioUrl,
  Number(meta.duration) > 0 ? Math.round(Number(meta.duration)) : 120,
  Number(meta.bpm) > 0 ? Math.round(Number(meta.bpm)) : null,
  meta.keyscale || null,
  meta.timesignature || null,
  '[]',
  JSON.stringify(generationParams),
);

console.log('✅ Imported song:');
console.log('   user     :', user.username, `(${user.id})`);
console.log('   songId   :', songId);
console.log('   title    :', title);
console.log('   audio_url:', audioUrl);
console.log('   file     :', destPath, `(${fs.statSync(destPath).size} bytes)`);
console.log('   bpm/dur  :', meta.bpm, '/', meta.duration, 's   seed:', meta.seed);

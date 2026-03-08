/**
 * chordService.ts — Chord progression engine for ProdIA Pro.
 *
 * Features:
 *   - Full chromatic note system (C to B, sharps/flats)
 *   - Major & minor scale chord quality mapping
 *   - Roman numeral ↔ absolute chord conversion
 *   - Web Audio API chord preview with piano-like synthesis
 *   - 25+ preset progressions organized by mood
 *   - Format functions for ACE-Step caption/lyrics injection
 */

// ---------------------------------------------------------------------------
// Note & Frequency System
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
type NoteName = typeof NOTE_NAMES[number];

// Enharmonic aliases (flat → sharp)
const ENHARMONIC: Record<string, NoteName> = {
  'Db': 'C#', 'Eb': 'D#', 'Fb': 'E', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B',
};

/** Get semitone index 0–11 from a note name. */
function noteIndex(name: string): number {
  const normalized = ENHARMONIC[name] || name;
  const idx = NOTE_NAMES.indexOf(normalized as NoteName);
  return idx >= 0 ? idx : 0;
}

/** MIDI note to frequency (A4=440Hz). */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Convert AudioBuffer → WAV Blob (16-bit PCM). */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = buffer.length;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and write samples
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Chord Qualities
// ---------------------------------------------------------------------------

export type ChordQuality = 'major' | 'minor' | 'dim' | 'aug' | 'maj7' | 'min7' | 'dom7' | 'dim7' | 'sus2' | 'sus4';

/** Intervals (semitones from root) for each chord quality. */
const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

// ---------------------------------------------------------------------------
// Scale Systems
// ---------------------------------------------------------------------------

export type ScaleType = 'major' | 'minor';

/** Semitone offsets for scale degrees 1–7. */
const SCALE_INTERVALS: Record<ScaleType, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

/** Default chord quality for each degree in major/minor. */
const SCALE_QUALITIES: Record<ScaleType, ChordQuality[]> = {
  major: ['major', 'minor', 'minor', 'major', 'major', 'minor', 'dim'],
  minor: ['minor', 'dim', 'major', 'minor', 'major', 'major', 'major'],
  //      i       ii°     III     iv      V(or v) VI      VII
};

// ---------------------------------------------------------------------------
// Roman Numeral Parsing
// ---------------------------------------------------------------------------

const ROMAN_MAP: Record<string, number> = {
  'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7,
  'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7,
};

export interface ChordToken {
  degree: number;        // 1-7
  quality: ChordQuality;
  roman: string;         // original roman numeral text
  isMinor: boolean;      // lowercase = minor context
  modifier?: string;     // '#' or 'b' prefix
}

/** Parse a single roman numeral token (e.g. "vi", "V#", "IVmaj7", "ii7"). */
export function parseRoman(token: string): ChordToken {
  let modifier: string | undefined;
  let rest = token.trim();

  // leading sharp/flat on the degree
  if (rest.startsWith('#') || rest.startsWith('b') || rest.startsWith('♯') || rest.startsWith('♭')) {
    modifier = rest[0] === '♯' ? '#' : rest[0] === '♭' ? 'b' : rest[0];
    rest = rest.slice(1);
  }

  // Split roman part from quality suffix
  const romanMatch = rest.match(/^(i{1,3}v?|v?i{0,3}|IV|V)/i);
  if (!romanMatch) {
    return { degree: 1, quality: 'major', roman: token, isMinor: false, modifier };
  }

  const romanPart = romanMatch[0];
  const suffix = rest.slice(romanPart.length).toLowerCase();
  const isMinor = romanPart === romanPart.toLowerCase();
  const degree = ROMAN_MAP[romanPart] || ROMAN_MAP[romanPart.toUpperCase()] || 1;

  // Determine quality from suffix or case
  let quality: ChordQuality;
  if (suffix.includes('maj7')) quality = 'maj7';
  else if (suffix.includes('dim7')) quality = 'dim7';
  else if (suffix.includes('dim') || suffix === '°' || suffix === 'o') quality = 'dim';
  else if (suffix.includes('aug') || suffix === '+') quality = 'aug';
  else if (suffix === '7' || suffix === 'dom7') quality = isMinor ? 'min7' : 'dom7';
  else if (suffix === 'm7') quality = 'min7';
  else if (suffix === 'sus2') quality = 'sus2';
  else if (suffix === 'sus4') quality = 'sus4';
  else if (suffix === '9') quality = isMinor ? 'min7' : 'dom7'; // simplify 9ths to 7ths
  else quality = isMinor ? 'minor' : 'major';

  return { degree, quality, roman: token, isMinor, modifier };
}

// ---------------------------------------------------------------------------
// Chord Resolution (Roman → Absolute)
// ---------------------------------------------------------------------------

export interface ResolvedChord {
  name: string;         // e.g. "Am", "Fmaj7"
  root: NoteName;       // root note name
  rootMidi: number;     // MIDI note of root (octave 4)
  notes: number[];      // MIDI notes of all chord tones
  quality: ChordQuality;
  roman: string;        // original roman
}

/** Resolve a roman numeral to an absolute chord in a given key/scale. */
export function resolveChord(token: ChordToken, key: string, scale: ScaleType): ResolvedChord {
  const keyIdx = noteIndex(key);
  const scaleIntervals = SCALE_INTERVALS[scale];
  const degreeOffset = scaleIntervals[(token.degree - 1) % 7];

  let modOffset = 0;
  if (token.modifier === '#') modOffset = 1;
  if (token.modifier === 'b') modOffset = -1;

  const rootSemitone = (keyIdx + degreeOffset + modOffset + 12) % 12;
  const root = NOTE_NAMES[rootSemitone];
  const rootMidi = 60 + rootSemitone; // C4 = 60

  // If rootMidi < 60 (shouldn't happen, but safety), shift up
  const baseMidi = rootSemitone < keyIdx ? 60 + rootSemitone + 12 : 60 + rootSemitone;
  const intervals = CHORD_INTERVALS[token.quality];
  const notes = intervals.map(i => baseMidi + i);

  // Human-readable name
  const qualitySuffix: Record<ChordQuality, string> = {
    major: '', minor: 'm', dim: 'dim', aug: 'aug',
    maj7: 'maj7', min7: 'm7', dom7: '7', dim7: 'dim7',
    sus2: 'sus2', sus4: 'sus4',
  };
  const name = `${root}${qualitySuffix[token.quality]}`;

  return { name, root, rootMidi: baseMidi, notes, quality: token.quality, roman: token.roman };
}

/** Parse and resolve a full progression string (e.g. "I - V - vi - IV"). */
export function resolveProgression(romanStr: string, key: string, scale: ScaleType): ResolvedChord[] {
  const tokens = romanStr.split(/[\s\-–—,]+/).filter(t => t.length > 0);
  return tokens.map(t => {
    const parsed = parseRoman(t);
    return resolveChord(parsed, key, scale);
  });
}

// ---------------------------------------------------------------------------
// Audio Engine — Web Audio API piano-like synthesis
// ---------------------------------------------------------------------------

export class ChordAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private activeNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private playTimer: number | null = null;
  private _isPlaying = false;
  private _onBeatCallback: ((index: number) => void) | null = null;

  get isPlaying(): boolean { return this._isPlaying; }

  /** Set a callback fired when each chord starts playing. */
  set onBeat(cb: ((index: number) => void) | null) { this._onBeatCallback = cb; }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.3;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /** Play a single chord (array of MIDI notes) for `duration` seconds. */
  playChord(notes: number[], duration = 0.8): void {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    notes.forEach(midi => {
      const freq = midiToFreq(midi);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      // Piano-like: triangle wave + fast attack, medium decay
      osc.type = 'triangle';
      osc.frequency.value = freq;

      // Add slight detuning for warmth
      osc.detune.value = (Math.random() - 0.5) * 6;

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.02); // fast attack
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.15); // sustain
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration); // release

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(now);
      osc.stop(now + duration + 0.05);

      this.activeNodes.push({ osc, gain });

      // Cleanup
      osc.onended = () => {
        this.activeNodes = this.activeNodes.filter(n => n.osc !== osc);
      };
    });

    // Add a subtle higher harmonic for "sparkle"
    if (notes.length > 0) {
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = midiToFreq(notes[0] + 12); // octave up
      gain2.gain.setValueAtTime(0, now);
      gain2.gain.linearRampToValueAtTime(0.06, now + 0.02);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.6);
      osc2.connect(gain2);
      gain2.connect(this.masterGain!);
      osc2.start(now);
      osc2.stop(now + duration + 0.05);
    }
  }

  /**
   * Play a full chord progression at given BPM.
   * @param beatsPerChord  How many beats each chord occupies (1 = fast harmonic rhythm, 4 = full bar in 4/4).
   */
  playProgression(chords: ResolvedChord[], bpm = 120, loop = false, beatsPerChord = 2): void {
    this.stop();
    this._isPlaying = true;

    const beatDuration = 60 / bpm; // seconds per beat
    const chordDuration = beatDuration * beatsPerChord;
    let index = 0;

    const playNext = () => {
      if (!this._isPlaying) return;
      if (index >= chords.length) {
        if (loop) {
          index = 0;
        } else {
          this._isPlaying = false;
          this._onBeatCallback?.(-1); // signal end
          return;
        }
      }

      const chord = chords[index];
      this.playChord(chord.notes, chordDuration * 0.9);
      this._onBeatCallback?.(index);
      index++;

      this.playTimer = window.setTimeout(playNext, chordDuration * 1000);
    };

    playNext();
  }

  /** Stop all playback. */
  stop(): void {
    this._isPlaying = false;
    if (this.playTimer !== null) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.activeNodes.forEach(({ osc, gain }) => {
      try {
        const ctx = this.ctx;
        if (ctx) {
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
          osc.stop(ctx.currentTime + 0.06);
        }
      } catch { }
    });
    this.activeNodes = [];
    this._onBeatCallback?.(-1);
  }

  /** Cleanup. */
  dispose(): void {
    this.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => { });
    }
    this.ctx = null;
    this.masterGain = null;
  }

  // ---------------------------------------------------------------------------
  // Offline render — produce a WAV Blob of the chord progression
  // ---------------------------------------------------------------------------

  /**
   * Render a chord progression to a WAV Blob using OfflineAudioContext.
   * This can be uploaded as reference audio so the model follows the harmonic content.
   *
   * @param chords  Resolved chords (with MIDI notes)
   * @param bpm     Tempo (beats per minute)
   * @param loops   Number of complete loops to render (default: 2)
   * @returns       WAV Blob ready for upload
   */
  async renderToBlob(chords: ResolvedChord[], bpm = 120, loops = 2, beatsPerChord = 2): Promise<Blob> {
    const sampleRate = 44100;
    const beatDuration = 60 / bpm;
    const chordDuration = beatDuration * beatsPerChord;
    const totalDuration = chordDuration * chords.length * loops + 0.5; // + tail

    const offline = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
    const masterGain = offline.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(offline.destination);

    for (let loop = 0; loop < loops; loop++) {
      chords.forEach((chord, idx) => {
        const startTime = (loop * chords.length + idx) * chordDuration;

        chord.notes.forEach(midi => {
          const freq = midiToFreq(midi);

          // Triangle wave (warm fundamental)
          const osc1 = offline.createOscillator();
          const g1 = offline.createGain();
          osc1.type = 'triangle';
          osc1.frequency.value = freq;
          osc1.detune.value = (Math.random() - 0.5) * 4;
          g1.gain.setValueAtTime(0, startTime);
          g1.gain.linearRampToValueAtTime(0.22, startTime + 0.02);
          g1.gain.exponentialRampToValueAtTime(0.14, startTime + 0.15);
          g1.gain.exponentialRampToValueAtTime(0.001, startTime + chordDuration * 0.92);
          osc1.connect(g1);
          g1.connect(masterGain);
          osc1.start(startTime);
          osc1.stop(startTime + chordDuration);

          // Sine wave (clean reinforcement)
          const osc2 = offline.createOscillator();
          const g2 = offline.createGain();
          osc2.type = 'sine';
          osc2.frequency.value = freq;
          g2.gain.setValueAtTime(0, startTime);
          g2.gain.linearRampToValueAtTime(0.08, startTime + 0.02);
          g2.gain.exponentialRampToValueAtTime(0.001, startTime + chordDuration * 0.7);
          osc2.connect(g2);
          g2.connect(masterGain);
          osc2.start(startTime);
          osc2.stop(startTime + chordDuration);
        });

        // Octave-up sparkle on root
        if (chord.notes.length > 0) {
          const osc3 = offline.createOscillator();
          const g3 = offline.createGain();
          osc3.type = 'sine';
          osc3.frequency.value = midiToFreq(chord.notes[0] + 12);
          g3.gain.setValueAtTime(0, startTime);
          g3.gain.linearRampToValueAtTime(0.04, startTime + 0.02);
          g3.gain.exponentialRampToValueAtTime(0.001, startTime + chordDuration * 0.5);
          osc3.connect(g3);
          g3.connect(masterGain);
          osc3.start(startTime);
          osc3.stop(startTime + chordDuration);
        }
      });
    }

    const buffer = await offline.startRendering();
    return audioBufferToWav(buffer);
  }
}

// ---------------------------------------------------------------------------
// Preset Library — 25+ progressions by mood
// ---------------------------------------------------------------------------

export type ProgressionMood = 'romantic' | 'dark' | 'upbeat' | 'jazz' | 'latin' | 'lofi' | 'epic' | 'folk';

export interface ChordPreset {
  id: string;
  name: string;
  key: string;
  scale: ScaleType;
  roman: string;       // "I - V - vi - IV"
  mood: ProgressionMood;
  description: string;
  emoji: string;
}

export const CHORD_PRESETS: ChordPreset[] = [
  // ===== ROMANTIC / EMOTIONAL =====
  { id: 'pop-canon', name: 'Pop Canon', key: 'C', scale: 'major', roman: 'I - V - vi - IV', mood: 'romantic', description: 'pop-canon-desc', emoji: '💕' },
  { id: 'sensitive', name: 'Sensible', key: 'G', scale: 'major', roman: 'vi - IV - I - V', mood: 'romantic', description: 'sensitive-desc', emoji: '🥹' },
  { id: 'fifties', name: 'Clásica 50s', key: 'C', scale: 'major', roman: 'I - vi - IV - V', mood: 'romantic', description: 'fifties-desc', emoji: '🎶' },
  { id: 'dreamy', name: 'Soñadora', key: 'D', scale: 'major', roman: 'I - iii - vi - IV', mood: 'romantic', description: 'dreamy-desc', emoji: '✨' },
  { id: 'emotional-climb', name: 'Ascenso Emotivo', key: 'A', scale: 'minor', roman: 'i - VII - VI - V', mood: 'romantic', description: 'emotional-climb-desc', emoji: '🌊' },
  { id: 'bm-romantic', name: 'Bm Romántica', key: 'B', scale: 'minor', roman: 'i - V - IV - I', mood: 'romantic', description: 'bm-romantic-desc', emoji: '💜' },
  { id: 'bm-epic-rom', name: 'Bm Épica Romántica', key: 'B', scale: 'minor', roman: 'i - V - VI - VII', mood: 'romantic', description: 'bm-epic-rom-desc', emoji: '🌅' },
  { id: 'ab-tender', name: 'Ab Tierna', key: 'G#', scale: 'major', roman: 'II - IV - I - V', mood: 'romantic', description: 'ab-tender-desc', emoji: '🌸' },
  { id: 'fm-passionate', name: 'F#m Apasionada', key: 'F#', scale: 'minor', roman: 'i - VI - VII - V', mood: 'romantic', description: 'fm-passionate-desc', emoji: '🔥' },
  { id: 'cm-melancholic', name: 'Cm Melancólica', key: 'C', scale: 'minor', roman: 'i - III - VII - IV', mood: 'romantic', description: 'cm-melancholic-desc', emoji: '🌙' },

  // ===== DARK / MOODY =====
  { id: 'andalusian', name: 'Andaluza', key: 'A', scale: 'minor', roman: 'i - VII - VI - V', mood: 'dark', description: 'andalusian-desc', emoji: '🖤' },
  { id: 'epic-minor', name: 'Épica Menor', key: 'D', scale: 'minor', roman: 'i - iv - VII - III', mood: 'dark', description: 'epic-minor-desc', emoji: '⚔️' },
  { id: 'minor-pop', name: 'Pop Oscuro', key: 'E', scale: 'minor', roman: 'i - VI - III - VII', mood: 'dark', description: 'minor-pop-desc', emoji: '🌑' },
  { id: 'dark-tension', name: 'Tensión Oscura', key: 'C', scale: 'minor', roman: 'i - VII - iv - V', mood: 'dark', description: 'dark-tension-desc', emoji: '😈' },
  { id: 'gothic', name: 'Gótica', key: 'G', scale: 'minor', roman: 'i - iv - i - V', mood: 'dark', description: 'gothic-desc', emoji: '🦇' },
  { id: 'doom', name: 'Doom Pesado', key: 'D', scale: 'minor', roman: 'i - bII - V - i', mood: 'dark', description: 'doom-desc', emoji: '💀' },

  // ===== UPBEAT / HAPPY =====
  { id: 'classic-rock', name: 'Rock Clásico', key: 'A', scale: 'major', roman: 'I - IV - V - I', mood: 'upbeat', description: 'classic-rock-desc', emoji: '🎸' },
  { id: 'country-folk', name: 'Country/Folk', key: 'G', scale: 'major', roman: 'I - V - IV - V', mood: 'upbeat', description: 'country-folk-desc', emoji: '🤠' },
  { id: 'bright-pop', name: 'Pop Brillante', key: 'C', scale: 'major', roman: 'I - IV - vi - V', mood: 'upbeat', description: 'bright-pop-desc', emoji: '☀️' },
  { id: 'bright-folk', name: 'Folk Luminoso', key: 'D', scale: 'major', roman: 'I - ii - IV - V', mood: 'upbeat', description: 'bright-folk-desc', emoji: '🌻' },
  { id: 'optimista', name: 'Optimista', key: 'F', scale: 'major', roman: 'I - V - vi - ii - IV - V', mood: 'upbeat', description: 'optimista-desc', emoji: '🎉' },

  // ===== JAZZ / SOPHISTICATED =====
  { id: 'jazz-251', name: 'Jazz II-V-I', key: 'C', scale: 'major', roman: 'ii7 - V7 - Imaj7', mood: 'jazz', description: 'jazz-251-desc', emoji: '🎷' },
  { id: 'jazz-turnaround', name: 'Jazz Turnaround', key: 'C', scale: 'major', roman: 'Imaj7 - vi7 - ii7 - V7', mood: 'jazz', description: 'jazz-turnaround-desc', emoji: '🎹' },
  { id: 'rhythm-changes', name: 'Rhythm Changes', key: 'Bb', scale: 'major', roman: 'I - VI7 - ii - V7', mood: 'jazz', description: 'rhythm-changes-desc', emoji: '🎺' },
  { id: 'circle-fifths', name: 'Círculo de Quintas', key: 'C', scale: 'major', roman: 'iii7 - vi7 - ii7 - V7', mood: 'jazz', description: 'circle-fifths-desc', emoji: '🔄' },

  // ===== LATIN / WORLD =====
  { id: 'reggaeton', name: 'Reggaetón', key: 'A', scale: 'minor', roman: 'i - iv - VII - III', mood: 'latin', description: 'reggaeton-desc', emoji: '🔊' },
  { id: 'latin-pop', name: 'Latin Pop', key: 'E', scale: 'minor', roman: 'i - VII - VI - VII', mood: 'latin', description: 'latin-pop-desc', emoji: '💃' },
  { id: 'flamenco', name: 'Flamenco', key: 'E', scale: 'minor', roman: 'i - iv - V - i', mood: 'latin', description: 'flamenco-desc', emoji: '🇪🇸' },
  { id: 'bossa', name: 'Bossa Nova', key: 'C', scale: 'major', roman: 'Imaj7 - ii7 - iii7 - vi7', mood: 'latin', description: 'bossa-desc', emoji: '🏖️' },

  // ===== LO-FI / CHILL =====
  { id: 'neosoul', name: 'Neo-Soul', key: 'D', scale: 'major', roman: 'Imaj7 - iii7 - vi7 - IVmaj7', mood: 'lofi', description: 'neosoul-desc', emoji: '🎧' },
  { id: 'lofi-jazz', name: 'Lo-Fi Jazz', key: 'F', scale: 'major', roman: 'ii7 - V7 - Imaj7 - vi7', mood: 'lofi', description: 'lofi-jazz-desc', emoji: '☕' },
  { id: 'chill-minor', name: 'Chill Minor', key: 'A', scale: 'minor', roman: 'i - III - VII - iv', mood: 'lofi', description: 'chill-minor-desc', emoji: '🌧️' },

  // ===== EPIC / CINEMATIC =====
  { id: 'heroic', name: 'Heroica', key: 'C', scale: 'major', roman: 'I - V - vi - iii - IV - I - IV - V', mood: 'epic', description: 'heroic-desc', emoji: '🏰' },
  { id: 'battle', name: 'Batalla', key: 'D', scale: 'minor', roman: 'i - III - VII - i', mood: 'epic', description: 'battle-desc', emoji: '⚡' },
  { id: 'triumph', name: 'Triunfo', key: 'C', scale: 'major', roman: 'IV - V - vi - I', mood: 'epic', description: 'triumph-desc', emoji: '🏆' },

  // ===== FOLK =====
  { id: 'celtic', name: 'Celta', key: 'D', scale: 'major', roman: 'I - IV - I - V', mood: 'folk', description: 'celtic-desc', emoji: '🍀' },
  { id: 'bluegrass', name: 'Bluegrass', key: 'G', scale: 'major', roman: 'I - IV - I - V - I', mood: 'folk', description: 'bluegrass-desc', emoji: '🎻' },
];

// ---------------------------------------------------------------------------
// Mood metadata
// ---------------------------------------------------------------------------

export const MOOD_INFO: Record<ProgressionMood, { label: string; emoji: string; color: string }> = {
  romantic: { label: 'mood-romantic', emoji: '💕', color: 'pink' },
  dark: { label: 'mood-dark', emoji: '🖤', color: 'red' },
  upbeat: { label: 'mood-upbeat', emoji: '☀️', color: 'yellow' },
  jazz: { label: 'mood-jazz', emoji: '🎷', color: 'amber' },
  latin: { label: 'mood-latin', emoji: '💃', color: 'orange' },
  lofi: { label: 'mood-lofi', emoji: '☕', color: 'cyan' },
  epic: { label: 'mood-epic', emoji: '⚔️', color: 'purple' },
  folk: { label: 'mood-folk', emoji: '🍀', color: 'green' },
};

export const ALL_MOODS: ProgressionMood[] = ['romantic', 'dark', 'upbeat', 'jazz', 'latin', 'lofi', 'epic', 'folk'];

// ---------------------------------------------------------------------------
// Available Keys for the selector
// ---------------------------------------------------------------------------

export const AVAILABLE_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Display-friendly key name (with enharmonic). */
export function displayKey(key: string): string {
  const enharmonicDisplay: Record<string, string> = {
    'C#': 'C# / Db', 'D#': 'D# / Eb', 'F#': 'F# / Gb', 'G#': 'G# / Ab', 'A#': 'A# / Bb',
  };
  return enharmonicDisplay[key] || key;
}

// ---------------------------------------------------------------------------
// Format for ACE-Step injection
// ---------------------------------------------------------------------------

/** Format a chord progression for the caption/style field. */
export function formatForCaption(chords: ResolvedChord[], key: string, scale: ScaleType): string {
  const chordNames = chords.map(c => c.name).join(' - ');
  const scaleLabel = scale === 'major' ? 'Major' : 'Minor';
  return `${key} ${scaleLabel}, ${chordNames} chord progression`;
}

/** Format chord progression as lyrics structure tags for section-by-section guidance. */
export function formatForLyrics(chords: ResolvedChord[], sectionName = 'Verse'): string {
  const chordNames = chords.map(c => c.name).join(' ');
  return `[${sectionName} - ${chordNames}]`;
}

/** Format a complete progression injection for both style and lyrics.
 *
 * The style tag uses explicit harmonic language that the model's caption encoder
 * understands best.  The lyrics tag wraps each section header with chords so
 * the diffusion model receives bar-level harmonic guidance.
 *
 * Returns a `bpmTag` too so the caller can sync BPM.
 */
export function formatProgressionForGeneration(
  romanStr: string,
  key: string,
  scale: ScaleType,
  bpm?: number,
): { styleTag: string; lyricsTag: string; description: string; bpmTag?: number; keyScaleTag: string } {
  const chords = resolveProgression(romanStr, key, scale);
  const chordNames = chords.map(c => c.name).join(' - ');
  const scaleLabel = scale === 'major' ? 'Major' : 'Minor';

  // Build a strong style tag the caption encoder will embed clearly
  const styleTag = `${key} ${scaleLabel} key, chord progression ${chordNames}, harmonic structure, ${scaleLabel.toLowerCase()} tonality`;

  // Lyrics-level chord guidance (section-by-section)
  const chordsInline = chords.map(c => c.name).join(' ');
  const lyricsTag = [
    `[Chord Progression: ${chordNames}]`,
    `[Verse - ${chordsInline}]`,
    `[Chorus - ${chordsInline}]`,
  ].join('\n');

  // Key + Scale tag for the backend
  const keyScaleTag = `${key} ${scaleLabel}`;

  return {
    styleTag,
    lyricsTag,
    description: `${key} ${scaleLabel}: ${romanStr} → ${chordNames}`,
    bpmTag: bpm && bpm > 0 ? bpm : undefined,
    keyScaleTag,
  };
}

// ---------------------------------------------------------------------------
// Singleton audio engine
// ---------------------------------------------------------------------------

let _engine: ChordAudioEngine | null = null;

export function getChordEngine(): ChordAudioEngine {
  if (!_engine) _engine = new ChordAudioEngine();
  return _engine;
}

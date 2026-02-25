# ACE Step MAX V0.1.0 — Features & Status

> Last updated: 2026-02-25

---

## Legend

| Icon | Meaning |
|------|---------|
| ✅ | Stable / Working |
| 🧪 | Beta / Experimental |
| 🚧 | In Progress |
| 📋 | Planned |

---

## New Features (MAX Fork)

### ✅ Branding — ACE Step MAX V0.1.0

All user-facing text has been renamed from "ACE-Step UI" to "ACE Step MAX".

- Page title, meta tags, sidebar, translations (EN/ZH/JA/KO)
- `package.json` name and version updated

---

### ✅ Audio Metadata Tagging (ID3)

Generated MP3 files are automatically tagged with metadata before being saved.

**Tags embedded:**
| Tag | Value |
|-----|-------|
| Title | Song title |
| Artist | Your username |
| Album | "ACE Step MAX" |
| BPM | Detected or user-specified BPM |
| Initial Key | Musical key (e.g. "G major") |
| Genre | Style/genre tags used for generation |
| Encoded By | "ACE Step MAX V0.1.0" |
| Comment | Summary of generation params |

**How it works:**
- Automatic — no action needed. Every newly generated MP3 gets tagged.
- Tags are written server-side using `node-id3` before the file is stored.
- FLAC files pass through untagged for now (FLAC tagging planned).

**Files involved:**
- `server/src/services/audioMetadata.ts` — tagging utility
- `server/src/routes/generate.ts` — integration point

---

### ✅ Edit Metadata (Song Context Menu)

Edit a song's metadata after generation directly from the song list.

**How to use:**
1. Right-click (or click `⋯`) on any song you own
2. Select **"Edit Metadata"** (Tag icon)
3. Modify any field:
   - **Title**
   - **Style / Genre**
   - **BPM** (30–300)
   - **Key** (dropdown: C major, A minor, F# minor, etc.)
   - **Time Signature** (2/4, 3/4, 4/4, 6/8)
4. Click **Save**

**Notes:**
- Only available for songs you own (isOwner)
- Changes are saved to the database immediately
- The song list and right sidebar update in real-time
- Does NOT re-tag the audio file — only updates the database record

**Files involved:**
- `components/EditMetadataModal.tsx` — the modal UI
- `components/SongDropdownMenu.tsx` — menu item
- `server/src/routes/songs.ts` — PATCH endpoint accepts `bpm`, `key_scale`, `time_signature`

---

### ✅ LoRA Quick Unload Button

Unload all active LoRA adapters with one click, even when the LoRA panel is collapsed.

**How to use:**
1. When a LoRA is loaded, a **green pulsing dot** appears next to "LoRA" in the header
2. A red **"Unload"** button appears to the right of the LoRA section header
3. Click it to immediately unload all LoRA adapters from the model

**Why this exists:**
- On page refresh, previously loaded LoRAs remain active on the backend
- This button lets you quickly clear them without expanding the LoRA panel

**Files involved:**
- `components/CreatePanel.tsx` — LoRA header section (~line 2800)

---

### ✅ Time Signature Dropdown Labels

The Time Signature field now shows proper musical notation instead of raw numbers.

| Display | Value sent to backend |
|---------|----------------------|
| Auto | (empty) |
| 2/4 | 2 |
| 3/4 | 3 |
| 4/4 | 4 |
| 6/8 | 6 |

Available in both Simple and Expert modes.

---

### ✅ Key Scale Dropdown Fix

The Key field correctly captures both note and mode (e.g. "G major", "C# minor") and properly extracts the value from `onChange` events in both modes.

---

### 🧪 Vocal Separation (Demucs)

Separate vocals and instrumentals from any audio file using Facebook's Demucs model.

**How to use:**
1. In the audio section, switch to the **Vocal** tab
2. Two options:
   - **"Separate from Library"** — pick a song from your library; Demucs will extract the vocals
   - **"Upload Acapella"** — upload a pre-separated vocal file directly
3. Wait for separation to complete (progress shown in UI)
4. The separated vocal becomes available as a reference

**Options:**
- **"Use vocal as Reference"** checkbox — auto-applies the separated vocal as reference audio
- **"Use instrumental as Source/Cover"** checkbox — auto-applies the instrumental for cover mode

**VRAM safety:**
- Generation is **disabled** while Demucs is running (they share VRAM)
- The generate button shows "Separating audio..." during separation

**Backend:**
- Uses `htdemucs_ft` model (high quality)
- Python script: `server/scripts/separate_audio.py`
- API endpoint: `POST /api/training/separate-stems`

**Status:** Beta — works but may need tuning for edge cases.

**Files involved:**
- `server/scripts/separate_audio.py` — Demucs wrapper
- `server/src/routes/training.ts` — API endpoint
- `components/CreatePanel.tsx` — Vocal tab UI

---

### 🧪 Prepare for Training

Quick button to prepare a song for LoRA training data.

**How to use:**
1. Right-click any song → **"Prepare for Training"**
2. A modal opens with the song details
3. Configure training parameters

**Status:** Beta — UI exists but training pipeline integration is experimental.

**Files involved:**
- `components/PrepareTrainingModal.tsx`

---

### ✅ Generation Config Viewer

View the exact parameters used to generate any song.

**How to use:**
1. Right-click any song → **"Generation Config"**
2. A modal shows all parameters: model, steps, seed, BPM, key, etc.

**Files involved:**
- `components/GenerationConfigModal.tsx`

---

### ✅ Cover Mode Bugfix

Fixed a bug where `taskType` remained set to `'cover'` after clearing the source audio, causing generation to fail with: `task_type='cover' requires a source audio or audio codes`.

**Fix:**
- Clearing source audio now resets `taskType` to `'text2music'`
- Safety guards in both Simple and Expert mode generate calls auto-correct `taskType` if no source audio exists

---

## Base Features (from upstream ACE-Step UI)

All original features remain fully functional:

- ✅ Full song generation (text2music, cover, repainting)
- ✅ Instrumental mode
- ✅ Custom BPM, key, duration, inference steps
- ✅ AI Enhance & Thinking Mode (LLM-powered)
- ✅ Batch generation & bulk queue
- ✅ Reference audio & source audio
- ✅ LoRA loading/unloading
- ✅ Spotify-inspired UI with dark/light mode
- ✅ Library management (search, filter, likes, playlists)
- ✅ Audio editor (AudioMass integration)
- ✅ Stem extraction (Demucs web UI)
- ✅ Video generator (Pexels backgrounds)
- ✅ Gradient album covers (procedural, no internet)
- ✅ LAN access
- ✅ Multi-language (EN, ZH, JA, KO)
- ✅ SQLite local-first database

---

## Planned / TODO

| Feature | Priority | Notes |
|---------|----------|-------|
| 📋 Cover art in ID3 tags | Medium | Embed generated album art into MP3 files |
| 📋 FLAC metadata tagging | Low | Vorbis comments for FLAC files |
| 📋 Re-tag existing songs | Medium | Batch re-tag already generated files with current metadata |
| 📋 Audio codes import/export | Low | Share generation codes between users |
| 📋 Training pipeline integration | Medium | End-to-end LoRA training from the UI |

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, TypeScript, TailwindCSS, Vite |
| Backend | Express.js, SQLite (better-sqlite3), node-id3 |
| AI Engine | ACE-Step 1.5 (Gradio API) |
| Audio Tools | AudioMass, Demucs, FFmpeg |
| Separation | Demucs htdemucs_ft (Python) |

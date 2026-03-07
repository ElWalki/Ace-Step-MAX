"""
ACE-Step Studio — Editor F0 / Piano Roll / Melodyne-style
Herramienta de producción para ACE-Step con análisis de voz,
piano roll interactivo, afinación y exportación.

Usa el entorno virtual de ACE-Step con librosa, torch, numpy, scipy, soundfile.

Autor: Walki / ProdIA_Max
"""

import struct
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import math
import wave
import array
import os
import threading
import json
import time

# ── Dependencias del venv ACE-Step ──
import numpy as np
import soundfile as sf

try:
    import librosa
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False

# ─────────────────────────────────────────────
# Constantes musicales
# ─────────────────────────────────────────────

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

SCALES = {
    "Mayor (Ionian)":     [0, 2, 4, 5, 7, 9, 11],
    "Menor Natural":      [0, 2, 3, 5, 7, 8, 10],
    "Pentatonica Mayor":  [0, 2, 4, 7, 9],
    "Pentatonica Menor":  [0, 3, 5, 7, 10],
    "Blues":               [0, 3, 5, 6, 7, 10],
    "Cromatica":           list(range(12)),
    "Japonesa (In)":       [0, 1, 5, 7, 8],
    "Japonesa (Yo)":       [0, 2, 5, 7, 9],
    "Armonica Menor":      [0, 2, 3, 5, 7, 8, 11],
    "Dorica":              [0, 2, 3, 5, 7, 9, 10],
    "Mixolidia":           [0, 2, 4, 5, 7, 9, 10],
    "Frigia":              [0, 1, 3, 5, 7, 8, 10],
}

# Colores Catppuccin Mocha
C = {
    "bg":        "#1e1e2e",
    "surface0":  "#313244",
    "surface1":  "#45475a",
    "surface2":  "#585b70",
    "overlay0":  "#6c7086",
    "text":      "#cdd6f4",
    "subtext":   "#a6adc8",
    "blue":      "#89b4fa",
    "green":     "#a6e3a1",
    "red":       "#f38ba8",
    "peach":     "#fab387",
    "yellow":    "#f9e2af",
    "mauve":     "#cba6f7",
    "teal":      "#94e2d5",
    "pink":      "#f5c2e7",
    "sky":       "#89dceb",
    "lavender":  "#b4befe",
    "flamingo":  "#f2cdcd",
    "canvas_bg": "#11111b",
    "note_bg":   "#89b4fa",
    "note_sel":  "#f9e2af",
    "note_ref":  "#a6e3a1",
    "grid_bar":  "#45475a",
    "grid_beat": "#313244",
    "grid_note": "#1e1e2e",
}


def freq_to_midi(freq_hz):
    if freq_hz <= 0:
        return 0
    return 69 + 12 * math.log2(freq_hz / 440.0)


def midi_to_freq(midi):
    return 440.0 * (2 ** ((midi - 69) / 12.0))


def midi_to_name(midi):
    midi_round = round(midi)
    octave = (midi_round // 12) - 1
    note = NOTE_NAMES[midi_round % 12]
    cents = int((midi - midi_round) * 100)
    return f"{note}{octave}", cents


def note_name_to_midi(name, octave):
    idx = NOTE_NAMES.index(name)
    return (octave + 1) * 12 + idx


def snap_to_scale(midi, root_midi, scale_intervals):
    """Cuantiza una nota MIDI a la escala mas cercana."""
    root = root_midi % 12
    candidates = []
    for octave_shift in range(-1, 2):
        for iv in scale_intervals:
            candidate = root + iv + (round(midi) // 12) * 12 + octave_shift * 12
            candidates.append(candidate)
    return min(candidates, key=lambda c: abs(c - midi))


# ─────────────────────────────────────────────
# NoteBlock — bloque del piano roll
# ─────────────────────────────────────────────

class NoteBlock:
    """Una nota en el piano roll."""
    _next_id = 0

    def __init__(self, start_s, duration_s, midi_note, velocity=100, is_reference=False, lyric=""):
        self.id = NoteBlock._next_id
        NoteBlock._next_id += 1
        self.start_s = start_s
        self.duration_s = duration_s
        self.midi_note = midi_note  # float para micropitch
        self.velocity = velocity
        self.is_reference = is_reference  # True = del audio importado
        self.lyric = lyric  # silaba/palabra para esta nota
        self.selected = False

    @property
    def end_s(self):
        return self.start_s + self.duration_s

    @property
    def freq_hz(self):
        return midi_to_freq(self.midi_note)

    @property
    def note_name(self):
        name, cents = midi_to_name(self.midi_note)
        return name

    def contains_point(self, time_s, midi):
        return (self.start_s <= time_s <= self.end_s and
                self.midi_note - 0.5 <= midi <= self.midi_note + 0.5)

    def to_dict(self):
        return {
            "start": self.start_s, "dur": self.duration_s,
            "midi": self.midi_note, "vel": self.velocity,
            "ref": self.is_reference, "lyric": self.lyric
        }

    @classmethod
    def from_dict(cls, d):
        nb = cls(d["start"], d["dur"], d["midi"], d.get("vel", 100),
                 d.get("ref", False), d.get("lyric", ""))
        return nb


# ─────────────────────────────────────────────
# F0 Analyzer — analisis de pitch desde audio
# ─────────────────────────────────────────────

class F0Analyzer:
    """Extrae F0 de un archivo de audio usando librosa pyin."""

    @staticmethod
    def analyze(audio_path, fmin=65, fmax=1047, hop_length=512, sr=None):
        """
        Retorna: (times, f0, voiced_flag, sr_loaded, duration, y)
        f0 en Hz, 0.0 donde no hay voz.
        """
        if not HAS_LIBROSA:
            raise RuntimeError("librosa no esta instalado")

        y, sr_loaded = librosa.load(audio_path, sr=sr, mono=True)
        duration = len(y) / sr_loaded

        f0, voiced, voicing_prob = librosa.pyin(
            y, fmin=fmin, fmax=fmax,
            sr=sr_loaded, hop_length=hop_length,
            fill_na=0.0
        )
        times = librosa.times_like(f0, sr=sr_loaded, hop_length=hop_length)

        return times, f0, voiced, sr_loaded, duration, y

    @staticmethod
    def f0_to_notes(times, f0, min_duration=0.05, min_freq=50):
        """
        Convierte curva F0 a NoteBlocks detectando regiones con pitch estable.
        """
        notes = []
        in_note = False
        note_start = 0
        note_midi_vals = []

        for i, (t, freq) in enumerate(zip(times, f0)):
            if freq > min_freq:
                midi = freq_to_midi(freq)
                if not in_note:
                    in_note = True
                    note_start = t
                    note_midi_vals = [midi]
                else:
                    note_midi_vals.append(midi)
            else:
                if in_note:
                    dur = t - note_start
                    if dur >= min_duration and note_midi_vals:
                        avg_midi = float(np.median(note_midi_vals))
                        notes.append(NoteBlock(note_start, dur, avg_midi, is_reference=True))
                    in_note = False
                    note_midi_vals = []

        # Cerrar ultima nota
        if in_note and note_midi_vals:
            dur = times[-1] - note_start
            if dur >= min_duration:
                avg_midi = float(np.median(note_midi_vals))
                notes.append(NoteBlock(note_start, dur, avg_midi, is_reference=True))

        return notes

    @staticmethod
    def chunk_by_silence(times, f0, min_silence=0.15):
        """
        Divide la secuencia en chunks separados por silencios.
        Retorna: lista de (start_s, end_s, chunk_index)
        """
        chunks = []
        in_chunk = False
        chunk_start = 0

        for i, (t, freq) in enumerate(zip(times, f0)):
            if freq > 50:
                if not in_chunk:
                    in_chunk = True
                    chunk_start = t
            else:
                if in_chunk:
                    chunks.append((chunk_start, t))
                    in_chunk = False

        if in_chunk:
            chunks.append((chunk_start, times[-1]))

        # Merge chunks que esten muy cerca
        merged = []
        for start, end in chunks:
            if merged and start - merged[-1][1] < min_silence:
                merged[-1] = (merged[-1][0], end)
            else:
                merged.append((start, end))

        return [(s, e, i) for i, (s, e) in enumerate(merged)]


# ─────────────────────────────────────────────
# Sintetizador simple (para preview)
# ─────────────────────────────────────────────

class Synthesizer:
    SAMPLE_RATE = 44100

    @staticmethod
    def notes_to_wav(notes, output_path, sr=44100, volume=0.6):
        """Genera WAV desde NoteBlocks con envolvente ADSR basica."""
        if not notes:
            return
        max_time = max(n.end_s for n in notes)
        n_samples = int(max_time * sr) + sr  # +1s padding
        buffer = np.zeros(n_samples, dtype=np.float32)

        for note in notes:
            freq = note.freq_hz
            start = int(note.start_s * sr)
            dur_samples = int(note.duration_s * sr)
            if dur_samples <= 0 or freq <= 0:
                continue

            t = np.arange(dur_samples) / sr

            # ADSR envolvente
            attack = min(int(0.01 * sr), dur_samples // 4)
            release = min(int(0.02 * sr), dur_samples // 4)
            sustain_level = 0.8
            env = np.ones(dur_samples, dtype=np.float32) * sustain_level
            if attack > 0:
                env[:attack] = np.linspace(0, 1, attack)
            if release > 0:
                env[-release:] = np.linspace(sustain_level, 0, release)

            # Sine + un armonico suave
            wave_data = (np.sin(2 * np.pi * freq * t) * 0.7 +
                         np.sin(2 * np.pi * freq * 2 * t) * 0.2 +
                         np.sin(2 * np.pi * freq * 3 * t) * 0.1)
            wave_data *= env * volume * (note.velocity / 127.0)

            end = start + dur_samples
            if end > len(buffer):
                wave_data = wave_data[:len(buffer) - start]
                end = len(buffer)
            buffer[start:end] += wave_data[:end - start]

        # Normalizar
        peak = np.max(np.abs(buffer))
        if peak > 0:
            buffer = buffer / peak * 0.9

        sf.write(output_path, buffer, sr)


# ─────────────────────────────────────────────
# Parser .dnni
# ─────────────────────────────────────────────

class DnniMarker:
    def __init__(self, offset, typ, name, data_start, data_bytes):
        self.offset = offset
        self.typ = typ
        self.name = name
        self.data_start = data_start
        self.data_bytes = data_bytes
        self.size = len(data_bytes)


class PhonemeSet:
    def __init__(self, language, phones, categories):
        self.language = language
        self.phones = phones
        self.categories = categories


class DnniFile:
    def __init__(self, path):
        self.path = path
        self.filename = os.path.basename(path)
        with open(path, 'rb') as f:
            self.raw = f.read()
        self.total_size = len(self.raw)
        self.markers = []
        self.phoneme_sets = []
        self.f0_config = {}
        self._parse()

    def _parse(self):
        self._find_markers()
        self._extract_phonemes()
        self._extract_f0_config()

    def _find_markers(self):
        data = self.raw
        i = 0
        raw_markers = []
        while i < len(data) - 4:
            if data[i] == 0xFF and data[i + 2] == 0xCA and data[i + 3] == 0x7F:
                str_start = i + 4
                str_end = data.find(b'\x00', str_start)
                if str_end == -1:
                    i += 1
                    continue
                name = data[str_start:str_end].decode('ascii', errors='replace')
                raw_markers.append((i, data[i + 1], name, str_end + 1))
                i = str_end + 1
            else:
                i += 1
        for idx, (off, typ, name, ds) in enumerate(raw_markers):
            next_off = raw_markers[idx + 1][0] if idx + 1 < len(raw_markers) else len(data)
            self.markers.append(DnniMarker(off, typ, name, ds, data[ds:next_off]))

    def _extract_phonemes(self):
        for m in self.markers:
            if m.name != '_psv1':
                continue
            raw = m.data_bytes
            lang_prefixes = [b'japanese', b'english', b'mandarin', b'korean',
                             b'spanish', b'french', b'german']
            lang_name = None
            lang_offset = None
            for lp in lang_prefixes:
                idx = raw.find(lp)
                if idx >= 0:
                    end = raw.find(b'\x00', idx)
                    if end == -1:
                        end = idx + 50
                    lang_name = raw[idx:end].decode('ascii', errors='replace')
                    lang_offset = idx
                    break
            if not lang_name or lang_offset is None:
                continue
            len_off = lang_offset - 4
            if len_off < 0:
                continue
            lang_strlen = struct.unpack('<I', raw[len_off:len_off + 4])[0]
            p = lang_offset + lang_strlen
            if p + 4 > len(raw):
                continue
            phone_count = struct.unpack('<I', raw[p:p + 4])[0]
            p += 4
            phones = []
            for _ in range(phone_count):
                if p + 4 > len(raw):
                    break
                slen = struct.unpack('<I', raw[p:p + 4])[0]
                p += 4
                if p + slen > len(raw):
                    break
                phones.append(raw[p:p + slen].decode('ascii', errors='replace'))
                p += slen
            categories = []
            if p + 4 <= len(raw):
                cat_count = struct.unpack('<I', raw[p:p + 4])[0]
                p += 4
                for _ in range(cat_count):
                    if p + 4 > len(raw):
                        break
                    slen = struct.unpack('<I', raw[p:p + 4])[0]
                    p += 4
                    if p + slen > len(raw):
                        break
                    categories.append(raw[p:p + slen].decode('ascii', errors='replace'))
                    p += slen
            clean_lang = lang_name.rstrip('*0123456789;')
            self.phoneme_sets.append(PhonemeSet(clean_lang, phones, categories))

    def _extract_f0_config(self):
        for m in self.markers:
            if m.name == '_f0g4v1' and m.size >= 24:
                self.f0_config['f0_shape'] = struct.unpack('<6I', m.data_bytes[:24])
            elif m.name == '_ff0fv1' and m.size >= 24:
                ints = struct.unpack('<3I', m.data_bytes[:12])
                floats = struct.unpack('<3f', m.data_bytes[12:24])
                self.f0_config['fine_dims'] = ints
                self.f0_config['frame_hop_s'] = floats[0]

    def get_section_summary(self):
        counts = {}
        sizes = {}
        for m in self.markers:
            counts[m.name] = counts.get(m.name, 0) + 1
            sizes[m.name] = sizes.get(m.name, 0) + m.size
        return [(n, counts[n], sizes[n]) for n in dict.fromkeys(c.name for c in self.markers)]


# ─────────────────────────────────────────────
# GUI Principal — ACE-Step Studio
# ─────────────────────────────────────────────

class AceStepStudio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ACE-Step Studio  --  Piano Roll & F0 Editor")
        self.geometry("1400x900")
        self.configure(bg=C["bg"])
        self.minsize(1000, 600)

        # Estado
        self.dnni = None
        self.notes = []             # NoteBlocks editables
        self.ref_notes = []         # NoteBlocks de referencia (audio importado)
        self.ref_f0_curve = None    # (times, f0) raw del audio
        self.ref_audio_path = None
        self.ref_waveform = None    # numpy array del audio
        self.ref_sr = None
        self.chunks = []            # (start, end, idx)
        self.duration = 8.0         # duracion total visible
        self.scroll_offset = 0.0    # offset temporal del scroll
        self.zoom_x = 1.0           # zoom horizontal
        self.zoom_y = 1.0           # zoom vertical
        self.midi_min = 48          # C3
        self.midi_max = 84          # C6

        # Interaccion
        self.drag_note = None
        self.drag_mode = None       # 'move', 'resize_r'
        self.drag_start = None
        self.drag_orig = None
        self.selection_rect = None
        self.current_tool = "select"  # select, draw, erase
        self.draw_note_start = None
        self.snap_to_grid = True
        self.grid_division = 0.25
        self.bpm = 120
        self.show_ref_curve = True
        self.show_ref_notes = True
        self.show_waveform = True
        self.quantize_enabled = False
        self.selected_scale = "Cromatica"
        self.root_note = "C"
        self.root_octave = 4

        self._create_styles()
        self._create_menu()
        self._create_layout()
        self._bind_shortcuts()

        # Cargar f0.dnni si existe
        default_dnni = os.path.join(os.path.dirname(os.path.abspath(__file__)), "f0.dnni")
        if os.path.exists(default_dnni):
            self.load_dnni(default_dnni)

    # === Styles ===

    def _create_styles(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure("Dark.TFrame", background=C["bg"])
        style.configure("Dark.TLabel", background=C["bg"], foreground=C["text"],
                         font=("Segoe UI", 10))
        style.configure("Header.TLabel", background=C["bg"], foreground=C["blue"],
                         font=("Segoe UI", 12, "bold"))
        style.configure("Tool.TButton", background=C["surface0"], foreground=C["text"],
                         font=("Segoe UI", 10), padding=4)
        style.configure("Active.TButton", background=C["blue"], foreground=C["bg"],
                         font=("Segoe UI", 10, "bold"), padding=4)
        style.configure("Accent.TButton", background=C["green"], foreground=C["bg"],
                         font=("Segoe UI", 10, "bold"), padding=6)
        style.configure("Dark.TNotebook", background=C["bg"])
        style.configure("Dark.TNotebook.Tab", background=C["surface0"],
                         foreground=C["text"], padding=[12, 4])
        style.map("Dark.TNotebook.Tab", background=[("selected", C["surface1"])])
        style.configure("Treeview", background=C["surface0"], foreground=C["text"],
                         fieldbackground=C["surface0"], font=("Consolas", 10))
        style.configure("Treeview.Heading", background=C["surface1"], foreground=C["blue"],
                         font=("Segoe UI", 10, "bold"))

    # === Menu ===

    def _create_menu(self):
        menubar = tk.Menu(self, bg=C["surface0"], fg=C["text"])

        file_menu = tk.Menu(menubar, tearoff=0, bg=C["surface0"], fg=C["text"])
        file_menu.add_command(label="Abrir .dnni...", command=self._open_dnni,
                              accelerator="Ctrl+O")
        file_menu.add_command(label="Importar Audio...", command=self._import_audio,
                              accelerator="Ctrl+I")
        file_menu.add_separator()
        file_menu.add_command(label="Guardar proyecto...", command=self._save_project,
                              accelerator="Ctrl+S")
        file_menu.add_command(label="Cargar proyecto...", command=self._load_project)
        file_menu.add_separator()
        file_menu.add_command(label="Exportar WAV...", command=self._export_wav,
                              accelerator="Ctrl+E")
        file_menu.add_command(label="Exportar F0 para ACE-Step...",
                              command=self._export_f0_for_acestep)
        file_menu.add_separator()
        file_menu.add_command(label="Salir", command=self.quit)
        menubar.add_cascade(label="Archivo", menu=file_menu)

        edit_menu = tk.Menu(menubar, tearoff=0, bg=C["surface0"], fg=C["text"])
        edit_menu.add_command(label="Seleccionar todo", command=self._select_all,
                              accelerator="Ctrl+A")
        edit_menu.add_command(label="Deseleccionar", command=self._deselect_all,
                              accelerator="Esc")
        edit_menu.add_command(label="Borrar seleccion", command=self._delete_selected,
                              accelerator="Del")
        edit_menu.add_separator()
        edit_menu.add_command(label="Cuantizar seleccion a escala",
                              command=self._quantize_selection, accelerator="Q")
        edit_menu.add_command(label="Copiar ref -> editable",
                              command=self._copy_ref_to_edit, accelerator="Ctrl+R")
        menubar.add_cascade(label="Editar", menu=edit_menu)

        view_menu = tk.Menu(menubar, tearoff=0, bg=C["surface0"], fg=C["text"])
        self._show_ref_curve_var = tk.BooleanVar(value=True)
        self._show_ref_notes_var = tk.BooleanVar(value=True)
        self._show_waveform_var = tk.BooleanVar(value=True)
        self._show_melody_curve_var = tk.BooleanVar(value=True)
        view_menu.add_checkbutton(label="Mostrar curva melodica",
                                   variable=self._show_melody_curve_var, command=self._redraw)
        view_menu.add_checkbutton(label="Mostrar curva F0 ref",
                                   variable=self._show_ref_curve_var, command=self._redraw)
        view_menu.add_checkbutton(label="Mostrar notas ref",
                                   variable=self._show_ref_notes_var, command=self._redraw)
        view_menu.add_checkbutton(label="Mostrar waveform",
                                   variable=self._show_waveform_var, command=self._redraw)
        menubar.add_cascade(label="Vista", menu=view_menu)

        self.config(menu=menubar)

    def _bind_shortcuts(self):
        self.bind("<Control-o>", lambda e: self._open_dnni())
        self.bind("<Control-i>", lambda e: self._import_audio())
        self.bind("<Control-s>", lambda e: self._save_project())
        self.bind("<Control-e>", lambda e: self._export_wav())
        self.bind("<Control-a>", lambda e: self._select_all())
        self.bind("<Control-r>", lambda e: self._copy_ref_to_edit())
        self.bind("<Escape>", lambda e: self._deselect_all())
        self.bind("<Delete>", lambda e: self._delete_selected())
        self.bind("<q>", lambda e: self._quantize_selection())
        self.bind("<Key-1>", lambda e: self._set_tool("select"))
        self.bind("<Key-2>", lambda e: self._set_tool("draw"))
        self.bind("<Key-3>", lambda e: self._set_tool("erase"))

    # === Layout ===

    def _create_layout(self):
        # -- Toolbar superior --
        toolbar = ttk.Frame(self, style="Dark.TFrame")
        toolbar.pack(fill=tk.X, padx=8, pady=(8, 2))

        # Herramientas
        tool_frame = ttk.Frame(toolbar, style="Dark.TFrame")
        tool_frame.pack(side=tk.LEFT)
        ttk.Label(tool_frame, text="Herramienta:",
                  style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.btn_select = ttk.Button(
            tool_frame, text="[] Seleccionar (1)", style="Active.TButton",
            command=lambda: self._set_tool("select"))
        self.btn_select.pack(side=tk.LEFT, padx=2)
        self.btn_draw = ttk.Button(
            tool_frame, text="# Dibujar (2)", style="Tool.TButton",
            command=lambda: self._set_tool("draw"))
        self.btn_draw.pack(side=tk.LEFT, padx=2)
        self.btn_erase = ttk.Button(
            tool_frame, text="X Borrar (3)", style="Tool.TButton",
            command=lambda: self._set_tool("erase"))
        self.btn_erase.pack(side=tk.LEFT, padx=2)

        ttk.Label(toolbar, text="  |  ", style="Dark.TLabel").pack(side=tk.LEFT)

        # BPM
        ttk.Label(toolbar, text="BPM:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(8, 2))
        self.bpm_var = tk.StringVar(value="120")
        bpm_entry = ttk.Entry(toolbar, textvariable=self.bpm_var, width=5)
        bpm_entry.pack(side=tk.LEFT, padx=2)
        self.bpm_var.trace_add("write", lambda *a: self._on_bpm_change())

        # Grid
        ttk.Label(toolbar, text="Grid:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(12, 2))
        self.grid_combo = ttk.Combobox(
            toolbar, values=["1/1", "1/2", "1/4", "1/8", "1/16", "Libre"],
            state="readonly", width=5)
        self.grid_combo.set("1/4")
        self.grid_combo.pack(side=tk.LEFT, padx=2)
        self.grid_combo.bind("<<ComboboxSelected>>", self._on_grid_change)

        # Snap
        self.snap_var = tk.BooleanVar(value=True)
        snap_cb = ttk.Checkbutton(toolbar, text="Snap", variable=self.snap_var)
        snap_cb.pack(side=tk.LEFT, padx=8)

        ttk.Label(toolbar, text="  |  ", style="Dark.TLabel").pack(side=tk.LEFT)

        # Escala + Root
        ttk.Label(toolbar, text="Escala:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(8, 2))
        self.scale_combo = ttk.Combobox(
            toolbar, values=list(SCALES.keys()), state="readonly", width=18)
        self.scale_combo.set("Cromatica")
        self.scale_combo.pack(side=tk.LEFT, padx=2)

        self.root_combo = ttk.Combobox(
            toolbar, values=NOTE_NAMES, state="readonly", width=4)
        self.root_combo.set("C")
        self.root_combo.pack(side=tk.LEFT, padx=2)

        self.oct_spin = ttk.Spinbox(toolbar, from_=1, to=7, width=3)
        self.oct_spin.set(4)
        self.oct_spin.pack(side=tk.LEFT, padx=2)

        ttk.Label(toolbar, text="  |  ", style="Dark.TLabel").pack(side=tk.LEFT)

        # Botones de accion
        ttk.Button(toolbar, text="> Play", style="Accent.TButton",
                    command=self._play).pack(side=tk.LEFT, padx=4)
        ttk.Button(toolbar, text="Importar Audio", style="Tool.TButton",
                    command=self._import_audio).pack(side=tk.LEFT, padx=4)

        # -- Notebook (pestanas) --
        self.notebook = ttk.Notebook(self, style="Dark.TNotebook")
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        # Tab 1: Piano Roll
        self.tab_piano = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_piano, text=" Piano Roll")
        self._create_piano_roll()

        # Tab 2: Info .dnni
        self.tab_info = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_info, text=" Info DNNI")
        self._create_info_tab()

        # Tab 3: Fonemas
        self.tab_phonemes = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_phonemes, text=" Fonemas")
        self._create_phonemes_tab()

        # Tab 4: Chunks
        self.tab_chunks = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_chunks, text=" Chunks")
        self._create_chunks_tab()

        # -- Status bar --
        status_frame = ttk.Frame(self, style="Dark.TFrame")
        status_frame.pack(fill=tk.X, padx=8, pady=(0, 6))
        self.status_var = tk.StringVar(
            value="Listo -- Importa audio o dibuja notas para empezar")
        ttk.Label(status_frame, textvariable=self.status_var,
                  style="Dark.TLabel").pack(side=tk.LEFT)
        self.pos_var = tk.StringVar(value="")
        ttk.Label(status_frame, textvariable=self.pos_var,
                  style="Dark.TLabel").pack(side=tk.RIGHT)

    # === Piano Roll Canvas ===

    def _create_piano_roll(self):
        main = ttk.Frame(self.tab_piano, style="Dark.TFrame")
        main.pack(fill=tk.BOTH, expand=True)

        # Piano keys (vertical, izquierda)
        self.piano_keys = tk.Canvas(main, width=60, bg=C["surface0"],
                                     highlightthickness=0)
        self.piano_keys.pack(side=tk.LEFT, fill=tk.Y)

        # Frame para canvas + scrollbar horizontal
        canvas_container = ttk.Frame(main, style="Dark.TFrame")
        canvas_container.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(canvas_container, bg=C["canvas_bg"],
                                 highlightthickness=0, cursor="crosshair")
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Scrollbar horizontal
        self.hscroll = ttk.Scrollbar(canvas_container, orient=tk.HORIZONTAL,
                                      command=self._on_hscroll)
        self.hscroll.pack(fill=tk.X)

        # Eventos canvas
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Button-3>", self._on_right_click)
        self.canvas.bind("<Double-Button-1>", self._on_double_click)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Configure>", lambda e: self._redraw())
        self.canvas.bind("<MouseWheel>", self._on_mousewheel)
        self.canvas.bind("<Shift-MouseWheel>", self._on_shift_mousewheel)
        self.piano_keys.bind("<Configure>", lambda e: self._draw_piano_keys())

    # === Info DNNI Tab ===

    def _create_info_tab(self):
        self.info_text = tk.Text(
            self.tab_info, bg=C["surface0"], fg=C["text"],
            font=("Consolas", 11), wrap=tk.WORD, relief=tk.FLAT,
            insertbackground=C["text"], padx=15, pady=15)
        self.info_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.info_text.tag_configure("header", foreground=C["blue"],
                                      font=("Consolas", 13, "bold"))
        self.info_text.tag_configure("key", foreground=C["green"],
                                      font=("Consolas", 11, "bold"))
        self.info_text.tag_configure("value", foreground=C["flamingo"],
                                      font=("Consolas", 11))
        self.info_text.tag_configure("dim", foreground=C["overlay0"],
                                      font=("Consolas", 10))

    # === Fonemas Tab ===

    def _create_phonemes_tab(self):
        top = ttk.Frame(self.tab_phonemes, style="Dark.TFrame")
        top.pack(fill=tk.X, padx=5, pady=5)
        ttk.Label(top, text="Idioma:", style="Dark.TLabel").pack(side=tk.LEFT, padx=5)
        self.lang_combo = ttk.Combobox(top, state="readonly", width=30)
        self.lang_combo.pack(side=tk.LEFT, padx=5)
        self.lang_combo.bind("<<ComboboxSelected>>", self._on_lang_select)

        cols = ("#", "Fonema", "Categoria")
        self.phone_tree = ttk.Treeview(self.tab_phonemes, columns=cols,
                                        show="headings", height=20)
        for col in cols:
            self.phone_tree.heading(col, text=col)
        self.phone_tree.column("#", width=50)
        self.phone_tree.column("Fonema", width=100)
        self.phone_tree.column("Categoria", width=200)
        scrollbar = ttk.Scrollbar(self.tab_phonemes, orient=tk.VERTICAL,
                                   command=self.phone_tree.yview)
        self.phone_tree.configure(yscrollcommand=scrollbar.set)
        self.phone_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y, pady=5)

    # === Chunks Tab ===

    def _create_chunks_tab(self):
        top = ttk.Frame(self.tab_chunks, style="Dark.TFrame")
        top.pack(fill=tk.X, padx=5, pady=5)
        ttk.Label(top, text="Silencio minimo para chunk (s):",
                  style="Dark.TLabel").pack(side=tk.LEFT, padx=5)
        self.chunk_silence_var = tk.StringVar(value="0.15")
        ttk.Entry(top, textvariable=self.chunk_silence_var,
                  width=6).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Re-analizar chunks",
                    command=self._reanalyze_chunks,
                    style="Tool.TButton").pack(side=tk.LEFT, padx=10)
        ttk.Button(top, text="Afinar chunk a escala",
                    command=self._quantize_chunk,
                    style="Tool.TButton").pack(side=tk.LEFT, padx=5)

        cols = ("Chunk", "Inicio", "Fin", "Duracion", "Notas", "Rango")
        self.chunk_tree = ttk.Treeview(self.tab_chunks, columns=cols,
                                        show="headings", height=15)
        for col in cols:
            self.chunk_tree.heading(col, text=col)
        self.chunk_tree.column("Chunk", width=60)
        self.chunk_tree.column("Inicio", width=80)
        self.chunk_tree.column("Fin", width=80)
        self.chunk_tree.column("Duracion", width=80)
        self.chunk_tree.column("Notas", width=60)
        self.chunk_tree.column("Rango", width=200)
        self.chunk_tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.chunk_tree.bind("<<TreeviewSelect>>", self._on_chunk_select)

    # =============================================
    # COORDINATE SYSTEM
    # =============================================

    def _time_to_x(self, time_s):
        w = self.canvas.winfo_width()
        visible_dur = self.duration / self.zoom_x
        if visible_dur <= 0:
            return 0
        return ((time_s - self.scroll_offset) / visible_dur) * w

    def _x_to_time(self, x):
        w = self.canvas.winfo_width()
        if w <= 0:
            return 0
        visible_dur = self.duration / self.zoom_x
        return (x / w) * visible_dur + self.scroll_offset

    def _midi_to_y(self, midi):
        h = self.canvas.winfo_height()
        if h <= 0:
            return 0
        midi_range = self.midi_max - self.midi_min
        if midi_range <= 0:
            return h / 2
        frac = (midi - self.midi_min) / midi_range
        return h - frac * h

    def _y_to_midi(self, y):
        h = self.canvas.winfo_height()
        if h <= 0:
            return 60
        midi_range = self.midi_max - self.midi_min
        return self.midi_min + (1 - y / h) * midi_range

    def _snap_time(self, t):
        if not self.snap_var.get():
            return t
        grid = self._get_grid_seconds()
        if grid <= 0:
            return t
        return round(t / grid) * grid

    def _get_grid_seconds(self):
        """Duracion de una celda de grid en segundos."""
        beat_dur = 60.0 / max(1, self.bpm)
        grid_val = self.grid_combo.get()
        mapping = {"1/1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "Libre": 0}
        mult = mapping.get(grid_val, 1)
        return beat_dur * mult if mult > 0 else 0

    def _note_height(self):
        h = self.canvas.winfo_height()
        midi_range = self.midi_max - self.midi_min
        if midi_range <= 0:
            return 12
        return max(4, h / midi_range)

    # =============================================
    # DRAWING
    # =============================================

    def _redraw(self, event=None):
        self.canvas.delete("all")
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        if w <= 1 or h <= 1:
            return

        self._draw_grid()
        if self._show_waveform_var.get() and self.ref_waveform is not None:
            self._draw_waveform()
        if self._show_ref_curve_var.get() and self.ref_f0_curve is not None:
            self._draw_ref_curve()
        self._draw_chunks_bg()
        if self._show_ref_notes_var.get():
            self._draw_notes(self.ref_notes, is_ref=True)
        self._draw_notes(self.notes, is_ref=False)
        self._draw_melody_curve()
        self._draw_piano_keys()
        self._update_hscroll()

    def _draw_grid(self):
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        nh = self._note_height()

        # Horizontal lines (notes)
        for midi in range(self.midi_min, self.midi_max + 1):
            y = self._midi_to_y(midi)
            note_in_oct = midi % 12
            is_c = note_in_oct == 0
            is_black = note_in_oct in [1, 3, 6, 8, 10]
            if is_c:
                self.canvas.create_line(0, y, w, y, fill=C["grid_bar"], width=2)
            else:
                self.canvas.create_line(0, y, w, y, fill=C["grid_beat"], width=1)
                if is_black:
                    self.canvas.create_rectangle(
                        0, y - nh / 2, w, y + nh / 2,
                        fill="#15151e", outline="")

        # Vertical lines (time grid)
        grid_s = self._get_grid_seconds()
        beat_dur = 60.0 / max(1, self.bpm)
        bar_dur = beat_dur * 4
        visible_dur = self.duration / self.zoom_x

        if grid_s > 0:
            t = self._snap_time(self.scroll_offset)
            while t <= self.scroll_offset + visible_dur:
                x = self._time_to_x(t)
                is_bar = (abs(t % bar_dur) < 0.001 or
                          abs(t % bar_dur - bar_dur) < 0.001)
                is_beat = (abs(t % beat_dur) < 0.001 or
                           abs(t % beat_dur - beat_dur) < 0.001)
                if is_bar:
                    self.canvas.create_line(x, 0, x, h, fill=C["grid_bar"], width=2)
                    bar_num = int(t / bar_dur) + 1
                    self.canvas.create_text(
                        x + 4, 12, text=str(bar_num),
                        fill=C["subtext"], anchor=tk.W, font=("Consolas", 9))
                elif is_beat:
                    self.canvas.create_line(x, 0, x, h, fill=C["grid_beat"], width=1)
                else:
                    self.canvas.create_line(
                        x, 0, x, h, fill="#1a1a2e", width=1, dash=(2, 4))
                t += grid_s

    def _draw_waveform(self):
        """Dibuja waveform del audio de referencia en el fondo."""
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        y_center = h // 2
        wf = self.ref_waveform
        sr = self.ref_sr
        visible_dur = self.duration / self.zoom_x

        start_sample = int(self.scroll_offset * sr)
        end_sample = int((self.scroll_offset + visible_dur) * sr)
        start_sample = max(0, start_sample)
        end_sample = min(len(wf), end_sample)

        if end_sample <= start_sample:
            return

        chunk = wf[start_sample:end_sample]
        n_points = min(w, len(chunk))
        if n_points < 2:
            return

        indices = np.linspace(0, len(chunk) - 1, n_points, dtype=int)
        samples = chunk[indices]

        coords = []
        wf_height = h * 0.15
        for i, s in enumerate(samples):
            x = (i / n_points) * w
            y = y_center - s * wf_height
            coords.extend([x, y])

        if len(coords) >= 4:
            self.canvas.create_line(*coords, fill=C["surface2"],
                                     width=1, smooth=False)

    def _draw_ref_curve(self):
        """Dibuja la curva F0 del audio de referencia."""
        times, f0 = self.ref_f0_curve
        visible_dur = self.duration / self.zoom_x

        coords = []
        for t, freq in zip(times, f0):
            if freq <= 0 or t < self.scroll_offset or t > self.scroll_offset + visible_dur:
                if coords and len(coords) >= 4:
                    self.canvas.create_line(*coords, fill=C["teal"],
                                             width=1, smooth=True)
                coords = []
                continue
            midi = freq_to_midi(freq)
            x = self._time_to_x(t)
            y = self._midi_to_y(midi)
            coords.extend([x, y])

        if len(coords) >= 4:
            self.canvas.create_line(*coords, fill=C["teal"], width=1, smooth=True)

    def _draw_chunks_bg(self):
        """Dibuja fondos coloreados para cada chunk."""
        chunk_colors = [C["mauve"], C["teal"], C["peach"], C["sky"], C["pink"], C["green"]]
        for start, end, idx in self.chunks:
            x1 = self._time_to_x(start)
            x2 = self._time_to_x(end)
            h = self.canvas.winfo_height()
            color = chunk_colors[idx % len(chunk_colors)]
            self.canvas.create_rectangle(
                x1, 0, x2, h, fill=color, outline="", stipple="gray12")
            self.canvas.create_text(
                (x1 + x2) / 2, 24, text=f"Ch.{idx + 1}",
                fill=color, font=("Consolas", 9, "bold"))

    def _draw_notes(self, note_list, is_ref=False):
        """Dibuja NoteBlocks como rectangulos en el piano roll."""
        nh = self._note_height()
        for note in note_list:
            x1 = self._time_to_x(note.start_s)
            x2 = self._time_to_x(note.end_s)
            y = self._midi_to_y(note.midi_note)

            if x2 < 0 or x1 > self.canvas.winfo_width():
                continue

            y1 = y - nh / 2
            y2 = y + nh / 2

            if is_ref:
                fill = C["note_ref"]
                outline = C["green"]
                alpha_stipple = "gray25"
            elif note.selected:
                fill = C["note_sel"]
                outline = C["yellow"]
                alpha_stipple = ""
            else:
                fill = C["note_bg"]
                outline = C["blue"]
                alpha_stipple = ""

            # Cuerpo de la nota
            self.canvas.create_rectangle(
                x1, y1, x2, y2, fill=fill, outline=outline,
                width=1, stipple=alpha_stipple, tags="note")

            # Handle de resize derecho
            if not is_ref:
                handle_w = max(4, min(8, (x2 - x1) * 0.15))
                self.canvas.create_rectangle(
                    x2 - handle_w, y1, x2, y2,
                    fill=outline, outline="", tags="note")

            # Nombre de nota + lyric
            note_width = x2 - x1
            if note_width > 25:
                name, cents = midi_to_name(note.midi_note)
                label = name
                if abs(cents) > 5:
                    label += f" {'+' if cents > 0 else ''}{cents}c"
                text_color = C["bg"] if not is_ref else C["surface0"]
                self.canvas.create_text(
                    x1 + 4, (y1 + y2) / 2, text=label,
                    fill=text_color, anchor=tk.W, font=("Consolas", 8))

                # Lyric encima de la nota
                if hasattr(note, 'lyric') and note.lyric:
                    self.canvas.create_text(
                        (x1 + x2) / 2, y1 - 8, text=note.lyric,
                        fill=C["pink"] if not is_ref else C["green"],
                        anchor=tk.S, font=("Segoe UI", 9, "bold"))
            elif hasattr(note, 'lyric') and note.lyric and note_width > 8:
                # Nota estrecha pero con lyric: mostrar solo lyric arriba
                self.canvas.create_text(
                    (x1 + x2) / 2, y1 - 6, text=note.lyric,
                    fill=C["pink"], anchor=tk.S, font=("Segoe UI", 8))

    def _draw_melody_curve(self):
        """Dibuja la curva melodica que conecta los centros de las notas editables."""
        if not self.notes or not self._show_melody_curve_var.get():
            return
        sorted_notes = sorted(self.notes, key=lambda n: n.start_s)
        coords = []
        for note in sorted_notes:
            cx = self._time_to_x(note.start_s + note.duration_s / 2)
            cy = self._midi_to_y(note.midi_note)
            if cx < -50 or cx > self.canvas.winfo_width() + 50:
                if coords and len(coords) >= 4:
                    self.canvas.create_line(*coords, fill=C["peach"],
                                             width=2, smooth=True, dash=(6, 3))
                coords = []
                continue
            coords.extend([cx, cy])
        if len(coords) >= 4:
            self.canvas.create_line(*coords, fill=C["peach"],
                                     width=2, smooth=True, dash=(6, 3))

    def _draw_piano_keys(self):
        """Dibuja las teclas del piano a la izquierda."""
        pk = self.piano_keys
        pk.delete("all")
        w = pk.winfo_width()
        nh = self._note_height()

        for midi in range(self.midi_min, self.midi_max + 1):
            y = self._midi_to_y(midi)
            y1 = y - nh / 2
            y2 = y + nh / 2
            note_in_oct = midi % 12
            is_black = note_in_oct in [1, 3, 6, 8, 10]
            is_c = note_in_oct == 0

            fill = "#2a2a3a" if is_black else "#3a3a4f"
            if is_c:
                fill = "#4a4a6f"

            pk.create_rectangle(0, y1, w, y2, fill=fill, outline=C["surface0"])

            name, _ = midi_to_name(midi)
            if not is_black:
                pk.create_text(
                    w - 4, (y1 + y2) / 2, text=name,
                    fill=C["text"] if is_c else C["subtext"],
                    anchor=tk.E,
                    font=("Consolas", 8 if is_c else 7,
                          "bold" if is_c else ""))

    def _update_hscroll(self):
        visible_dur = self.duration / self.zoom_x
        total = max(self.duration, visible_dur)
        if total <= 0:
            return
        lo = self.scroll_offset / total
        hi = (self.scroll_offset + visible_dur) / total
        self.hscroll.set(lo, hi)

    # =============================================
    # INTERACTION -- Mouse
    # =============================================

    def _on_click(self, event):
        t = self._x_to_time(event.x)
        midi = self._y_to_midi(event.y)

        if self.current_tool == "select":
            clicked_note = self._find_note_at(t, midi, self.notes)
            if clicked_note:
                if not (event.state & 0x4):  # no Ctrl
                    if not clicked_note.selected:
                        self._deselect_all()
                clicked_note.selected = True

                x_note_end = self._time_to_x(clicked_note.end_s)
                handle_zone = max(6, min(12,
                    (x_note_end - self._time_to_x(clicked_note.start_s)) * 0.15))
                if abs(event.x - x_note_end) < handle_zone:
                    self.drag_mode = "resize_r"
                else:
                    self.drag_mode = "move"

                self.drag_note = clicked_note
                self.drag_start = (event.x, event.y)
                self.drag_orig = (clicked_note.start_s, clicked_note.midi_note,
                                  clicked_note.duration_s)
            else:
                self._deselect_all()
                self.selection_rect = (event.x, event.y, event.x, event.y)

            self._redraw()

        elif self.current_tool == "draw":
            snapped_t = self._snap_time(t)
            snapped_midi = round(midi)
            grid_s = self._get_grid_seconds()
            min_dur = grid_s if grid_s > 0 else 0.1
            new_note = NoteBlock(snapped_t, min_dur, snapped_midi)
            new_note.selected = True
            self.notes.append(new_note)
            self.draw_note_start = new_note
            self.drag_mode = "resize_r"
            self.drag_note = new_note
            self.drag_start = (event.x, event.y)
            self.drag_orig = (new_note.start_s, new_note.midi_note,
                              new_note.duration_s)
            self._redraw()

        elif self.current_tool == "erase":
            clicked = self._find_note_at(t, midi, self.notes)
            if clicked:
                self.notes.remove(clicked)
                self._redraw()

    def _on_drag(self, event):
        if self.drag_note and self.drag_start and self.drag_orig:
            t = self._x_to_time(event.x)
            midi = self._y_to_midi(event.y)
            orig_start, orig_midi, orig_dur = self.drag_orig

            if self.drag_mode == "move":
                dt = t - self._x_to_time(self.drag_start[0])
                dm = midi - self._y_to_midi(self.drag_start[1])
                new_start = self._snap_time(orig_start + dt)
                new_midi = (round(orig_midi + dm) if self.snap_var.get()
                            else orig_midi + dm)

                # Mover todas las notas seleccionadas
                for note in self.notes:
                    if note.selected and note is not self.drag_note:
                        offset_t = note.start_s - self.drag_note.start_s
                        offset_m = note.midi_note - self.drag_note.midi_note
                        note.start_s = max(0, new_start + offset_t)
                        note.midi_note = max(self.midi_min,
                                             min(self.midi_max, new_midi + offset_m))

                self.drag_note.start_s = max(0, new_start)
                self.drag_note.midi_note = max(self.midi_min,
                                               min(self.midi_max, new_midi))

            elif self.drag_mode == "resize_r":
                new_end = self._snap_time(t)
                new_dur = max(0.02, new_end - self.drag_note.start_s)
                self.drag_note.duration_s = new_dur

            self._redraw()

        elif self.selection_rect and self.current_tool == "select":
            self.selection_rect = (self.selection_rect[0], self.selection_rect[1],
                                   event.x, event.y)
            self.canvas.delete("sel_rect")
            x1, y1, x2, y2 = self.selection_rect
            self.canvas.create_rectangle(
                x1, y1, x2, y2, outline=C["blue"],
                width=1, dash=(3, 3), tags="sel_rect")

    def _on_release(self, event):
        if self.selection_rect and self.current_tool == "select":
            x1, y1, x2, y2 = self.selection_rect
            t1, t2 = sorted([self._x_to_time(x1), self._x_to_time(x2)])
            m1, m2 = sorted([self._y_to_midi(y1), self._y_to_midi(y2)])

            for note in self.notes:
                if (note.start_s < t2 and note.end_s > t1 and
                        note.midi_note >= m1 - 0.5 and note.midi_note <= m2 + 0.5):
                    note.selected = True

        self.drag_note = None
        self.drag_mode = None
        self.drag_start = None
        self.drag_orig = None
        self.selection_rect = None
        self.draw_note_start = None
        self._redraw()

    def _on_right_click(self, event):
        t = self._x_to_time(event.x)
        midi = self._y_to_midi(event.y)
        clicked = self._find_note_at(t, midi, self.notes)
        if clicked:
            self.notes.remove(clicked)
            self._redraw()

    def _on_double_click(self, event):
        """Doble click en una nota para editar su lyric (silaba/palabra)."""
        t = self._x_to_time(event.x)
        midi = self._y_to_midi(event.y)
        clicked = self._find_note_at(t, midi, self.notes)
        if not clicked:
            return

        # Crear un Entry temporal sobre la nota
        x1 = self._time_to_x(clicked.start_s)
        x2 = self._time_to_x(clicked.end_s)
        y = self._midi_to_y(clicked.midi_note)
        nh = self._note_height()

        entry_w = max(40, int(x2 - x1))
        entry = tk.Entry(self.canvas, font=("Segoe UI", 10),
                         bg=C["surface1"], fg=C["pink"],
                         insertbackground=C["pink"], justify=tk.CENTER,
                         relief=tk.FLAT, bd=2)
        entry.insert(0, clicked.lyric if hasattr(clicked, 'lyric') else "")
        entry.select_range(0, tk.END)

        entry_id = self.canvas.create_window(
            (x1 + x2) / 2, y - nh / 2 - 14,
            window=entry, width=entry_w, height=20, anchor=tk.S)
        entry.focus_set()

        def commit(evt=None):
            clicked.lyric = entry.get().strip()
            self.canvas.delete(entry_id)
            entry.destroy()
            self._redraw()

        def cancel(evt=None):
            self.canvas.delete(entry_id)
            entry.destroy()

        entry.bind("<Return>", commit)
        entry.bind("<Escape>", cancel)
        entry.bind("<FocusOut>", commit)

    def _on_motion(self, event):
        t = self._x_to_time(event.x)
        midi = self._y_to_midi(event.y)
        name, cents = midi_to_name(midi)
        freq = midi_to_freq(midi)
        self.pos_var.set(f"{t:.2f}s  |  {name} ({freq:.1f} Hz)  |  MIDI {midi:.1f}")

        if self.current_tool == "select":
            note = self._find_note_at(t, midi, self.notes)
            if note:
                x_end = self._time_to_x(note.end_s)
                handle = max(6, min(12,
                    (x_end - self._time_to_x(note.start_s)) * 0.15))
                if abs(event.x - x_end) < handle:
                    self.canvas.config(cursor="sb_h_double_arrow")
                else:
                    self.canvas.config(cursor="fleur")
            else:
                self.canvas.config(cursor="crosshair")

    def _on_mousewheel(self, event):
        """Zoom vertical (MIDI range)."""
        delta = 1 if event.delta > 0 else -1
        new_min = self.midi_min - delta * 2
        new_max = self.midi_max + delta * 2
        if new_max - new_min >= 12 and new_min >= 21 and new_max <= 108:
            self.midi_min = new_min
            self.midi_max = new_max
        self._redraw()

    def _on_shift_mousewheel(self, event):
        """Zoom horizontal (time)."""
        delta = 1 if event.delta > 0 else -1
        self.zoom_x = max(0.25, min(8.0, self.zoom_x + delta * 0.15))
        self._redraw()

    def _on_hscroll(self, *args):
        if args[0] == "moveto":
            frac = float(args[1])
            self.scroll_offset = frac * self.duration
            self._redraw()
        elif args[0] == "scroll":
            amount = int(args[1])
            visible_dur = self.duration / self.zoom_x
            self.scroll_offset += amount * visible_dur * 0.1
            self.scroll_offset = max(0,
                min(self.duration - visible_dur, self.scroll_offset))
            self._redraw()

    def _find_note_at(self, time_s, midi, note_list):
        """Encuentra la nota mas cercana al punto dado."""
        for note in reversed(note_list):
            if note.contains_point(time_s, midi):
                return note
        return None

    # =============================================
    # TOOLS & ACTIONS
    # =============================================

    def _set_tool(self, tool):
        self.current_tool = tool
        self.btn_select.configure(
            style="Active.TButton" if tool == "select" else "Tool.TButton")
        self.btn_draw.configure(
            style="Active.TButton" if tool == "draw" else "Tool.TButton")
        self.btn_erase.configure(
            style="Active.TButton" if tool == "erase" else "Tool.TButton")
        cursors = {"select": "crosshair", "draw": "pencil", "erase": "X_cursor"}
        self.canvas.config(cursor=cursors.get(tool, "crosshair"))
        self.status_var.set(f"Herramienta: {tool}")

    def _on_bpm_change(self):
        try:
            self.bpm = max(1, int(self.bpm_var.get()))
        except ValueError:
            pass

    def _on_grid_change(self, event=None):
        self._redraw()

    def _select_all(self):
        for n in self.notes:
            n.selected = True
        self._redraw()

    def _deselect_all(self):
        for n in self.notes:
            n.selected = False
        self._redraw()

    def _delete_selected(self):
        self.notes = [n for n in self.notes if not n.selected]
        self._redraw()

    def _quantize_selection(self):
        """Cuantiza notas seleccionadas a la escala elegida."""
        scale_name = self.scale_combo.get()
        intervals = SCALES.get(scale_name, list(range(12)))
        root = note_name_to_midi(self.root_combo.get(), int(self.oct_spin.get()))

        count = 0
        for note in self.notes:
            if note.selected:
                note.midi_note = snap_to_scale(note.midi_note, root, intervals)
                count += 1

        self.status_var.set(f"Cuantizadas {count} notas a {scale_name}")
        self._redraw()

    def _copy_ref_to_edit(self):
        """Copia las notas de referencia como notas editables."""
        count = 0
        for ref in self.ref_notes:
            new_note = NoteBlock(ref.start_s, ref.duration_s, ref.midi_note,
                                  ref.velocity, is_reference=False)
            self.notes.append(new_note)
            count += 1
        self.status_var.set(f"Copiadas {count} notas de referencia")
        self._redraw()

    # =============================================
    # FILE OPERATIONS
    # =============================================

    def _open_dnni(self):
        path = filedialog.askopenfilename(
            title="Abrir archivo .dnni",
            filetypes=[("DiffSinger DNNI", "*.dnni"), ("Todos", "*.*")],
            initialdir=os.path.dirname(os.path.abspath(__file__)))
        if path:
            self.load_dnni(path)

    def load_dnni(self, path):
        try:
            self.dnni = DnniFile(path)
            self._populate_info()
            self._populate_phonemes()
            self.status_var.set(
                f"DNNI cargado: {self.dnni.filename} ({self.dnni.total_size:,} bytes)")
        except Exception as e:
            messagebox.showerror("Error", f"Error cargando .dnni:\n{e}")

    def _import_audio(self):
        path = filedialog.askopenfilename(
            title="Importar audio de referencia",
            filetypes=[("Audio", "*.wav *.mp3 *.flac *.ogg *.m4a"),
                       ("Todos", "*.*")],
            initialdir=os.path.dirname(os.path.abspath(__file__)))
        if path:
            self._analyze_audio(path)

    def _analyze_audio(self, path):
        if not HAS_LIBROSA:
            messagebox.showerror("Error",
                "librosa no esta instalado.\nEjecuta: pip install librosa")
            return

        self.status_var.set(f"Analizando {os.path.basename(path)}...")
        self.update()

        def analyze():
            try:
                times, f0, voiced, sr, duration, y = F0Analyzer.analyze(path)
                ref_notes = F0Analyzer.f0_to_notes(times, f0)

                try:
                    min_sil = float(self.chunk_silence_var.get())
                except Exception:
                    min_sil = 0.15
                chunks = F0Analyzer.chunk_by_silence(times, f0, min_silence=min_sil)

                self.after(0, lambda: self._on_analysis_done(
                    path, times, f0, sr, duration, y, ref_notes, chunks))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error analisis", str(e)))

        threading.Thread(target=analyze, daemon=True).start()

    def _on_analysis_done(self, path, times, f0, sr, duration, y,
                          ref_notes, chunks):
        self.ref_audio_path = path
        self.ref_f0_curve = (times, f0)
        self.ref_sr = sr
        self.ref_waveform = y
        self.ref_notes = ref_notes
        self.chunks = chunks
        self.duration = max(self.duration, duration + 1)

        # Auto-ajustar rango MIDI
        if ref_notes:
            midis = [n.midi_note for n in ref_notes]
            self.midi_min = max(24, int(min(midis)) - 5)
            self.midi_max = min(108, int(max(midis)) + 5)

        self._populate_chunks()
        self._redraw()
        self.status_var.set(
            f"Audio importado: {os.path.basename(path)} | "
            f"{len(ref_notes)} notas detectadas | {len(chunks)} chunks | "
            f"{duration:.1f}s")

    def _reanalyze_chunks(self):
        if self.ref_f0_curve is None:
            messagebox.showwarning("Sin datos", "Importa un audio primero.")
            return
        try:
            min_sil = float(self.chunk_silence_var.get())
        except Exception:
            min_sil = 0.15
        times, f0 = self.ref_f0_curve
        self.chunks = F0Analyzer.chunk_by_silence(times, f0, min_silence=min_sil)
        self._populate_chunks()
        self._redraw()

    def _quantize_chunk(self):
        """Afinar notas de referencia de un chunk seleccionado a la escala."""
        sel = self.chunk_tree.selection()
        if not sel:
            messagebox.showinfo("Info", "Selecciona un chunk primero.")
            return

        idx = self.chunk_tree.index(sel[0])
        if idx >= len(self.chunks):
            return

        start, end, _ = self.chunks[idx]
        scale_name = self.scale_combo.get()
        intervals = SCALES.get(scale_name, list(range(12)))
        root = note_name_to_midi(self.root_combo.get(), int(self.oct_spin.get()))

        count = 0
        for ref in self.ref_notes:
            if ref.start_s >= start and ref.end_s <= end:
                new_midi = snap_to_scale(ref.midi_note, root, intervals)
                new_note = NoteBlock(ref.start_s, ref.duration_s, new_midi,
                                      ref.velocity, is_reference=False)
                self.notes.append(new_note)
                count += 1

        self.status_var.set(f"Chunk {idx + 1}: {count} notas afinadas a {scale_name}")
        self._redraw()

    def _on_chunk_select(self, event):
        sel = self.chunk_tree.selection()
        if not sel:
            return
        idx = self.chunk_tree.index(sel[0])
        if idx < len(self.chunks):
            start, end, _ = self.chunks[idx]
            self.scroll_offset = max(0, start - 0.5)
            self._redraw()

    def _populate_chunks(self):
        tree = self.chunk_tree
        tree.delete(*tree.get_children())
        for start, end, idx in self.chunks:
            dur = end - start
            n_notes = sum(1 for n in self.ref_notes
                          if n.start_s >= start and n.end_s <= end)
            chunk_notes = [n for n in self.ref_notes
                           if n.start_s >= start and n.end_s <= end]
            if chunk_notes:
                midis = [n.midi_note for n in chunk_notes]
                low_name, _ = midi_to_name(min(midis))
                high_name, _ = midi_to_name(max(midis))
                rng = f"{low_name} -> {high_name}"
            else:
                rng = "--"
            tree.insert("", tk.END, values=(
                idx + 1, f"{start:.2f}s", f"{end:.2f}s",
                f"{dur:.2f}s", n_notes, rng))

    def _export_wav(self):
        if not self.notes:
            messagebox.showwarning("Sin notas",
                "No hay notas editables para exportar.")
            return
        path = filedialog.asksaveasfilename(
            title="Exportar WAV", defaultextension=".wav",
            filetypes=[("WAV Audio", "*.wav")],
            initialdir=os.path.dirname(os.path.abspath(__file__)),
            initialfile="ace_melody.wav")
        if not path:
            return

        self.status_var.set("Exportando WAV...")
        self.update()

        def export():
            try:
                Synthesizer.notes_to_wav(self.notes, path)
                self.after(0, lambda: self.status_var.set(
                    f"WAV exportado: {path}"))
                self.after(0, lambda: messagebox.showinfo(
                    "OK", f"Audio guardado:\n{path}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))

        threading.Thread(target=export, daemon=True).start()

    def _export_f0_for_acestep(self):
        """Exporta la curva F0 como JSON para usar en ACE-Step."""
        all_notes = sorted(self.notes, key=lambda n: n.start_s)
        if not all_notes:
            messagebox.showwarning("Sin datos", "No hay notas para exportar.")
            return

        path = filedialog.asksaveasfilename(
            title="Exportar F0 para ACE-Step", defaultextension=".json",
            filetypes=[("JSON", "*.json")],
            initialdir=os.path.dirname(os.path.abspath(__file__)),
            initialfile="f0_melody.json")
        if not path:
            return

        # Generar curva F0 con resolucion de 5ms (200fps, como el .dnni)
        hop = 0.005
        max_t = max(n.end_s for n in all_notes)
        n_frames = int(max_t / hop)
        f0_curve = []

        for i in range(n_frames):
            t = i * hop
            freq = 0
            for note in all_notes:
                if note.start_s <= t <= note.end_s:
                    freq = note.freq_hz
                    break
            f0_curve.append(round(freq, 2))

        # Generar secuencia de lyrics alineadas con las notas
        lyrics_sequence = []
        for note in all_notes:
            lyric = getattr(note, 'lyric', '') or ''
            lyrics_sequence.append({
                "text": lyric,
                "start_s": note.start_s,
                "end_s": note.end_s,
                "midi": note.midi_note,
                "note": note.note_name,
                "freq_hz": round(note.freq_hz, 2)
            })

        # Texto completo de la letra
        full_lyrics = " ".join(l["text"] for l in lyrics_sequence if l["text"])

        export_data = {
            "source": "ace_step_studio",
            "bpm": self.bpm,
            "duration_s": max_t,
            "hop_s": hop,
            "fps": int(1 / hop),
            "f0_hz": f0_curve,
            "notes": [n.to_dict() for n in all_notes],
            "lyrics": full_lyrics,
            "lyrics_aligned": lyrics_sequence,
            "scale": self.scale_combo.get(),
            "root": self.root_combo.get() + self.oct_spin.get(),
        }

        with open(path, 'w') as f:
            json.dump(export_data, f, indent=2)

        self.status_var.set(
            f"F0 exportado: {path} ({n_frames} frames, {len(all_notes)} notas)")
        messagebox.showinfo("OK", f"F0 guardado para ACE-Step:\n{path}")

    def _play(self):
        if not self.notes:
            messagebox.showwarning("Sin notas",
                "No hay notas para reproducir.")
            return

        temp = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "_preview.wav")
        self.status_var.set("Generando preview...")
        self.update()

        def play():
            try:
                Synthesizer.notes_to_wav(self.notes, temp)
                os.startfile(temp)
                self.after(0, lambda: self.status_var.set("Reproduciendo..."))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))

        threading.Thread(target=play, daemon=True).start()

    def _save_project(self):
        path = filedialog.asksaveasfilename(
            title="Guardar proyecto", defaultextension=".acsproj",
            filetypes=[("ACE-Step Studio Project", "*.acsproj")],
            initialdir=os.path.dirname(os.path.abspath(__file__)))
        if not path:
            return
        data = {
            "version": 1,
            "bpm": self.bpm,
            "duration": self.duration,
            "midi_min": self.midi_min,
            "midi_max": self.midi_max,
            "scale": self.scale_combo.get(),
            "root": self.root_combo.get(),
            "root_oct": self.oct_spin.get(),
            "notes": [n.to_dict() for n in self.notes],
            "ref_notes": [n.to_dict() for n in self.ref_notes],
            "ref_audio": self.ref_audio_path,
        }
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)
        self.status_var.set(f"Proyecto guardado: {path}")

    def _load_project(self):
        path = filedialog.askopenfilename(
            title="Cargar proyecto",
            filetypes=[("ACE-Step Studio Project", "*.acsproj")],
            initialdir=os.path.dirname(os.path.abspath(__file__)))
        if not path:
            return
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            self.bpm = data.get("bpm", 120)
            self.bpm_var.set(str(self.bpm))
            self.duration = data.get("duration", 8.0)
            self.midi_min = data.get("midi_min", 48)
            self.midi_max = data.get("midi_max", 84)
            self.scale_combo.set(data.get("scale", "Cromatica"))
            self.root_combo.set(data.get("root", "C"))
            self.oct_spin.set(data.get("root_oct", "4"))
            self.notes = [NoteBlock.from_dict(d) for d in data.get("notes", [])]
            self.ref_notes = [NoteBlock.from_dict(d)
                              for d in data.get("ref_notes", [])]

            ref_audio = data.get("ref_audio")
            if ref_audio and os.path.exists(ref_audio):
                self._analyze_audio(ref_audio)

            self._redraw()
            self.status_var.set(f"Proyecto cargado: {path}")
        except Exception as e:
            messagebox.showerror("Error", str(e))

    # == Info ==

    def _populate_info(self):
        d = self.dnni
        t = self.info_text
        t.config(state=tk.NORMAL)
        t.delete("1.0", tk.END)
        t.insert(tk.END, "=== ARCHIVO DNNI ===\n\n", "header")
        for key, val in [("Archivo", d.filename),
                         ("Tamano", f"{d.total_size:,} bytes"),
                         ("Secciones", str(len(d.markers))),
                         ("Idiomas", str(len(d.phoneme_sets)))]:
            t.insert(tk.END, f"  {key}: ", "key")
            t.insert(tk.END, f"{val}\n", "value")
        t.insert(tk.END, "\n=== IDIOMAS ===\n\n", "header")
        for ps in d.phoneme_sets:
            t.insert(tk.END, f"  {ps.language}\n", "key")
            t.insert(tk.END,
                f"     {len(ps.phones)} fonemas: {', '.join(ps.phones)}\n\n", "dim")
        if d.f0_config:
            t.insert(tk.END, "=== CONFIG F0 ===\n\n", "header")
            if 'frame_hop_s' in d.f0_config:
                hop = d.f0_config['frame_hop_s']
                t.insert(tk.END, f"  Frame Hop: ", "key")
                t.insert(tk.END, f"{hop:.4f}s ({1/hop:.0f} fps)\n", "value")
        t.insert(tk.END, "\n=== SECCIONES ===\n\n", "header")
        for name, count, size in d.get_section_summary():
            t.insert(tk.END, f"  {name or '(header)':<15} ", "key")
            t.insert(tk.END, f"x{count:>3}   {size:>10,} B\n", "value")
        t.config(state=tk.DISABLED)

    def _populate_phonemes(self):
        langs = [ps.language for ps in self.dnni.phoneme_sets]
        self.lang_combo['values'] = langs
        if langs:
            self.lang_combo.current(0)
            self._on_lang_select(None)

    def _on_lang_select(self, event):
        idx = self.lang_combo.current()
        if idx < 0:
            return
        ps = self.dnni.phoneme_sets[idx]
        self.phone_tree.delete(*self.phone_tree.get_children())
        for i, phone in enumerate(ps.phones):
            cat = ps.categories[i] if i < len(ps.categories) else "--"
            self.phone_tree.insert("", tk.END, values=(i, phone, cat))


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    app = AceStepStudio()
    app.mainloop()

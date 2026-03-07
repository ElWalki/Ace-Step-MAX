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

# ─────────────────────────────────────────────
# Parser del formato .dnni
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
            if data[i] == 0xFF and data[i+2] == 0xCA and data[i+3] == 0x7F:
                str_start = i + 4
                str_end = data.find(b'\x00', str_start)
                if str_end == -1:
                    i += 1
                    continue
                name = data[str_start:str_end].decode('ascii', errors='replace')
                raw_markers.append((i, data[i+1], name, str_end + 1))
                i = str_end + 1
            else:
                i += 1

        for idx, (off, typ, name, ds) in enumerate(raw_markers):
            if idx + 1 < len(raw_markers):
                next_off = raw_markers[idx+1][0]
            else:
                next_off = len(data)
            block = data[ds:next_off]
            self.markers.append(DnniMarker(off, typ, name, ds, block))

    def _extract_phonemes(self):
        for m in self.markers:
            if m.name != '_psv1':
                continue
            raw = m.data_bytes
            # Buscar nombre de idioma
            lang_prefixes = [b'japanese', b'english', b'mandarin', b'korean', b'spanish', b'french', b'german']
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

            # language name length uint32 está justo antes del nombre
            len_off = lang_offset - 4
            if len_off < 0:
                continue
            lang_strlen = struct.unpack('<I', raw[len_off:len_off+4])[0]

            # Phoneme count + list
            p = lang_offset + lang_strlen
            if p + 4 > len(raw):
                continue
            phone_count = struct.unpack('<I', raw[p:p+4])[0]
            p += 4

            phones = []
            for _ in range(phone_count):
                if p + 4 > len(raw):
                    break
                slen = struct.unpack('<I', raw[p:p+4])[0]
                p += 4
                if p + slen > len(raw):
                    break
                phone = raw[p:p+slen].decode('ascii', errors='replace')
                phones.append(phone)
                p += slen

            # Categorías (misma estructura, siguiente bloque)
            categories = []
            if p + 4 <= len(raw):
                cat_count = struct.unpack('<I', raw[p:p+4])[0]
                p += 4
                for _ in range(cat_count):
                    if p + 4 > len(raw):
                        break
                    slen = struct.unpack('<I', raw[p:p+4])[0]
                    p += 4
                    if p + slen > len(raw):
                        break
                    cat = raw[p:p+slen].decode('ascii', errors='replace')
                    categories.append(cat)
                    p += slen

            # Limpiar nombre de idioma (quitar trailing chars no-alfa)
            clean_lang = lang_name.rstrip('*0123456789;')
            self.phoneme_sets.append(PhonemeSet(clean_lang, phones, categories))

    def _extract_f0_config(self):
        for m in self.markers:
            if m.name == '_f0g4v1' and m.size >= 24:
                vals = struct.unpack('<6I', m.data_bytes[:24])
                self.f0_config['f0_shape'] = vals
            elif m.name == '_ff0fv1' and m.size >= 24:
                ints = struct.unpack('<3I', m.data_bytes[:12])
                floats = struct.unpack('<3f', m.data_bytes[12:24])
                self.f0_config['fine_dims'] = ints
                self.f0_config['frame_hop_s'] = floats[0]
                self.f0_config['param1'] = floats[1]
                self.f0_config['param2'] = floats[2]

    def get_section_summary(self):
        """Resumen de secciones únicas con conteos."""
        counts = {}
        sizes = {}
        for m in self.markers:
            counts[m.name] = counts.get(m.name, 0) + 1
            sizes[m.name] = sizes.get(m.name, 0) + m.size
        return [(name, counts[name], sizes[name]) for name in dict.fromkeys(c.name for c in self.markers)]


# ─────────────────────────────────────────────
# Generador de audio F0
# ─────────────────────────────────────────────

class F0Synthesizer:
    """Genera WAV con onda sinusoidal siguiendo una curva F0."""

    SAMPLE_RATE = 44100

    @staticmethod
    def generate_sine_wav(f0_curve, duration_s, output_path, sample_rate=44100, volume=0.7):
        """
        f0_curve: lista de (time_s, freq_hz) — puntos de la curva F0.
        Interpola linealmente entre ellos y genera una onda sinusoidal.
        """
        n_samples = int(duration_s * sample_rate)
        samples = array.array('h')  # signed short

        # Ordenar por tiempo
        f0_curve = sorted(f0_curve, key=lambda x: x[0])
        if not f0_curve:
            return

        phase = 0.0
        max_amp = int(32767 * volume)

        for i in range(n_samples):
            t = i / sample_rate
            # Interpolar frecuencia
            freq = F0Synthesizer._interpolate_f0(f0_curve, t)
            if freq <= 0:
                samples.append(0)
                continue

            sample = int(max_amp * math.sin(phase))
            samples.append(max(min(sample, 32767), -32768))
            phase += 2 * math.pi * freq / sample_rate

        with wave.open(output_path, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(samples.tobytes())

    @staticmethod
    def _interpolate_f0(curve, t):
        if t <= curve[0][0]:
            return curve[0][1]
        if t >= curve[-1][0]:
            return curve[-1][1]
        for i in range(len(curve) - 1):
            t0, f0 = curve[i]
            t1, f1 = curve[i+1]
            if t0 <= t <= t1:
                if t1 == t0:
                    return f0
                ratio = (t - t0) / (t1 - t0)
                return f0 + ratio * (f1 - f0)
        return 0


# ─────────────────────────────────────────────
# Notas musicales helper
# ─────────────────────────────────────────────

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

def freq_to_note(freq_hz):
    """Convierte Hz a nombre de nota (ej: A4 = 440Hz)."""
    if freq_hz <= 0:
        return "---"
    midi = 69 + 12 * math.log2(freq_hz / 440.0)
    midi_round = round(midi)
    octave = (midi_round // 12) - 1
    note = NOTE_NAMES[midi_round % 12]
    cents = int((midi - midi_round) * 100)
    sign = "+" if cents >= 0 else ""
    return f"{note}{octave} ({sign}{cents}c)"

def note_to_freq(note_name, octave):
    """Convierte nota+octava a Hz."""
    idx = NOTE_NAMES.index(note_name)
    midi = (octave + 1) * 12 + idx
    return 440.0 * (2 ** ((midi - 69) / 12.0))

# Escalas predefinidas
SCALES = {
    "Mayor (Ionian)":     [0, 2, 4, 5, 7, 9, 11],
    "Menor Natural":      [0, 2, 3, 5, 7, 8, 10],
    "Pentatónica Mayor":  [0, 2, 4, 7, 9],
    "Pentatónica Menor":  [0, 3, 5, 7, 10],
    "Blues":               [0, 3, 5, 6, 7, 10],
    "Cromática":           list(range(12)),
    "Japonesa (In)":       [0, 1, 5, 7, 8],
    "Japonesa (Yo)":       [0, 2, 5, 7, 9],
}


# ─────────────────────────────────────────────
# GUI Principal
# ─────────────────────────────────────────────

class DnniExplorer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("🎵 Explorador DNNI — DiffSinger Neural Network Inference")
        self.geometry("1200x800")
        self.configure(bg="#1e1e2e")
        self.dnni = None
        self.f0_points = []  # Lista de (time_s, freq_hz)

        self._create_styles()
        self._create_menu()
        self._create_layout()

        # Cargar archivo por defecto si existe
        default_path = os.path.join(os.path.dirname(__file__), "f0.dnni")
        if os.path.exists(default_path):
            self.load_file(default_path)

    def _create_styles(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure("Dark.TFrame", background="#1e1e2e")
        style.configure("Dark.TLabel", background="#1e1e2e", foreground="#cdd6f4", font=("Segoe UI", 10))
        style.configure("Header.TLabel", background="#1e1e2e", foreground="#89b4fa", font=("Segoe UI", 14, "bold"))
        style.configure("Dark.TButton", background="#313244", foreground="#cdd6f4", font=("Segoe UI", 10))
        style.configure("Accent.TButton", background="#89b4fa", foreground="#1e1e2e", font=("Segoe UI", 10, "bold"))
        style.configure("Dark.TNotebook", background="#1e1e2e")
        style.configure("Dark.TNotebook.Tab", background="#313244", foreground="#cdd6f4", padding=[12, 4])
        style.map("Dark.TNotebook.Tab", background=[("selected", "#45475a")])
        style.configure("Treeview", background="#313244", foreground="#cdd6f4",
                         fieldbackground="#313244", font=("Consolas", 10))
        style.configure("Treeview.Heading", background="#45475a", foreground="#89b4fa", font=("Segoe UI", 10, "bold"))
        style.map("Treeview", background=[("selected", "#585b70")])

    def _create_menu(self):
        menubar = tk.Menu(self, bg="#313244", fg="#cdd6f4")
        file_menu = tk.Menu(menubar, tearoff=0, bg="#313244", fg="#cdd6f4")
        file_menu.add_command(label="Abrir .dnni...", command=self.open_file_dialog, accelerator="Ctrl+O")
        file_menu.add_separator()
        file_menu.add_command(label="Salir", command=self.quit)
        menubar.add_cascade(label="Archivo", menu=file_menu)
        self.config(menu=menubar)
        self.bind("<Control-o>", lambda e: self.open_file_dialog())

    def _create_layout(self):
        # Notebook con pestañas
        self.notebook = ttk.Notebook(self, style="Dark.TNotebook")
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # Tab 1: Info General
        self.tab_info = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_info, text="📋 Info General")
        self._create_info_tab()

        # Tab 2: Estructura
        self.tab_structure = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_structure, text="🧱 Estructura")
        self._create_structure_tab()

        # Tab 3: Fonemas
        self.tab_phonemes = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_phonemes, text="🗣️ Fonemas")
        self._create_phonemes_tab()

        # Tab 4: F0 Editor
        self.tab_f0 = ttk.Frame(self.notebook, style="Dark.TFrame")
        self.notebook.add(self.tab_f0, text="🎹 Editor F0")
        self._create_f0_tab()

        # Status bar
        self.status_var = tk.StringVar(value="Abrir un archivo .dnni para empezar")
        status = ttk.Label(self, textvariable=self.status_var, style="Dark.TLabel")
        status.pack(side=tk.BOTTOM, fill=tk.X, padx=10, pady=5)

    def _create_info_tab(self):
        self.info_text = tk.Text(self.tab_info, bg="#313244", fg="#cdd6f4",
                                  font=("Consolas", 11), wrap=tk.WORD, relief=tk.FLAT,
                                  insertbackground="#cdd6f4", padx=15, pady=15)
        self.info_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.info_text.tag_configure("header", foreground="#89b4fa", font=("Consolas", 13, "bold"))
        self.info_text.tag_configure("key", foreground="#a6e3a1", font=("Consolas", 11, "bold"))
        self.info_text.tag_configure("value", foreground="#f5e0dc", font=("Consolas", 11))
        self.info_text.tag_configure("dim", foreground="#6c7086", font=("Consolas", 10))

    def _create_structure_tab(self):
        cols = ("Offset", "Tipo", "Nombre", "Tamaño", "Hex Preview")
        self.struct_tree = ttk.Treeview(self.tab_structure, columns=cols, show="headings", height=25)
        for col in cols:
            self.struct_tree.heading(col, text=col)
        self.struct_tree.column("Offset", width=100)
        self.struct_tree.column("Tipo", width=60)
        self.struct_tree.column("Nombre", width=150)
        self.struct_tree.column("Tamaño", width=100)
        self.struct_tree.column("Hex Preview", width=500)

        scrollbar = ttk.Scrollbar(self.tab_structure, orient=tk.VERTICAL, command=self.struct_tree.yview)
        self.struct_tree.configure(yscrollcommand=scrollbar.set)
        self.struct_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y, pady=5)

    def _create_phonemes_tab(self):
        # Frame superior: selector de idioma
        top = ttk.Frame(self.tab_phonemes, style="Dark.TFrame")
        top.pack(fill=tk.X, padx=5, pady=5)
        ttk.Label(top, text="Idioma:", style="Dark.TLabel").pack(side=tk.LEFT, padx=5)
        self.lang_combo = ttk.Combobox(top, state="readonly", width=30)
        self.lang_combo.pack(side=tk.LEFT, padx=5)
        self.lang_combo.bind("<<ComboboxSelected>>", self._on_lang_select)

        # Tabla de fonemas
        cols = ("#", "Fonema", "Categoría")
        self.phone_tree = ttk.Treeview(self.tab_phonemes, columns=cols, show="headings", height=20)
        for col in cols:
            self.phone_tree.heading(col, text=col)
        self.phone_tree.column("#", width=50)
        self.phone_tree.column("Fonema", width=100)
        self.phone_tree.column("Categoría", width=200)

        scrollbar = ttk.Scrollbar(self.tab_phonemes, orient=tk.VERTICAL, command=self.phone_tree.yview)
        self.phone_tree.configure(yscrollcommand=scrollbar.set)
        self.phone_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y, pady=5)

    def _create_f0_tab(self):
        # ── Panel de controles ──
        controls = ttk.Frame(self.tab_f0, style="Dark.TFrame")
        controls.pack(fill=tk.X, padx=5, pady=5)

        # Fila 1: Nota base + Escala
        row1 = ttk.Frame(controls, style="Dark.TFrame")
        row1.pack(fill=tk.X, pady=2)

        ttk.Label(row1, text="Nota base:", style="Dark.TLabel").pack(side=tk.LEFT, padx=5)
        self.base_note = ttk.Combobox(row1, values=NOTE_NAMES, state="readonly", width=5)
        self.base_note.set("C")
        self.base_note.pack(side=tk.LEFT, padx=2)

        ttk.Label(row1, text="Octava:", style="Dark.TLabel").pack(side=tk.LEFT, padx=5)
        self.base_octave = ttk.Spinbox(row1, from_=1, to=7, width=3)
        self.base_octave.set(4)
        self.base_octave.pack(side=tk.LEFT, padx=2)

        ttk.Label(row1, text="Escala:", style="Dark.TLabel").pack(side=tk.LEFT, padx=15)
        self.scale_combo = ttk.Combobox(row1, values=list(SCALES.keys()), state="readonly", width=20)
        self.scale_combo.set("Pentatónica Menor")
        self.scale_combo.pack(side=tk.LEFT, padx=2)

        ttk.Label(row1, text="Duración (s):", style="Dark.TLabel").pack(side=tk.LEFT, padx=15)
        self.duration_var = tk.StringVar(value="4.0")
        ttk.Entry(row1, textvariable=self.duration_var, width=6).pack(side=tk.LEFT, padx=2)

        # Fila 2: Botones
        row2 = ttk.Frame(controls, style="Dark.TFrame")
        row2.pack(fill=tk.X, pady=5)

        ttk.Button(row2, text="🎵 Generar escala", command=self._gen_scale).pack(side=tk.LEFT, padx=5)
        ttk.Button(row2, text="🎲 Melodía aleatoria", command=self._gen_random_melody).pack(side=tk.LEFT, padx=5)
        ttk.Button(row2, text="🗑️ Limpiar", command=self._clear_f0).pack(side=tk.LEFT, padx=5)
        ttk.Button(row2, text="💾 Exportar WAV", command=self._export_wav).pack(side=tk.LEFT, padx=15)
        ttk.Button(row2, text="▶ Reproducir", command=self._play_audio).pack(side=tk.LEFT, padx=5)

        # ── Canvas para dibujar F0 ──
        canvas_frame = ttk.Frame(self.tab_f0, style="Dark.TFrame")
        canvas_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.f0_canvas = tk.Canvas(canvas_frame, bg="#181825", highlightthickness=0, cursor="crosshair")
        self.f0_canvas.pack(fill=tk.BOTH, expand=True)

        # Eventos de dibujo
        self.f0_canvas.bind("<Button-1>", self._on_canvas_click)
        self.f0_canvas.bind("<B1-Motion>", self._on_canvas_drag)
        self.f0_canvas.bind("<Button-3>", self._on_canvas_right_click)
        self.f0_canvas.bind("<Configure>", self._redraw_f0)

        # Info del canvas
        info = ttk.Label(self.tab_f0, text="Click izquierdo: añadir punto  |  Arrastrar: dibujar curva  |  Click derecho: borrar punto cercano", style="Dark.TLabel")
        info.pack(padx=5, pady=2)

    # ─────────────── Carga de archivo ───────────────

    def open_file_dialog(self):
        path = filedialog.askopenfilename(
            title="Abrir archivo .dnni",
            filetypes=[("DiffSinger DNNI", "*.dnni"), ("Todos", "*.*")],
            initialdir=os.path.dirname(__file__)
        )
        if path:
            self.load_file(path)

    def load_file(self, path):
        try:
            self.dnni = DnniFile(path)
            self.status_var.set(f"Cargado: {self.dnni.filename}  ({self.dnni.total_size:,} bytes)")
            self._populate_info()
            self._populate_structure()
            self._populate_phonemes()
            self._redraw_f0()
        except Exception as e:
            messagebox.showerror("Error", f"No se pudo cargar el archivo:\n{e}")

    # ─────────────── Info tab ───────────────

    def _populate_info(self):
        d = self.dnni
        t = self.info_text
        t.config(state=tk.NORMAL)
        t.delete("1.0", tk.END)

        t.insert(tk.END, "═══ ARCHIVO DNNI ═══\n\n", "header")

        info_lines = [
            ("Archivo", d.filename),
            ("Ruta", d.path),
            ("Tamaño", f"{d.total_size:,} bytes ({d.total_size/1024/1024:.2f} MB)"),
            ("Secciones totales", str(len(d.markers))),
            ("Idiomas", str(len(d.phoneme_sets))),
        ]

        for key, val in info_lines:
            t.insert(tk.END, f"  {key}: ", "key")
            t.insert(tk.END, f"{val}\n", "value")

        t.insert(tk.END, "\n═══ IDIOMAS SOPORTADOS ═══\n\n", "header")
        for ps in d.phoneme_sets:
            t.insert(tk.END, f"  🌐 {ps.language}\n", "key")
            t.insert(tk.END, f"     {len(ps.phones)} fonemas: ", "dim")
            t.insert(tk.END, f"{', '.join(ps.phones)}\n\n", "value")

        t.insert(tk.END, "═══ CONFIGURACIÓN F0 ═══\n\n", "header")
        if d.f0_config:
            if 'f0_shape' in d.f0_config:
                t.insert(tk.END, "  F0 Shape: ", "key")
                t.insert(tk.END, f"{d.f0_config['f0_shape']}\n", "value")
            if 'frame_hop_s' in d.f0_config:
                hop = d.f0_config['frame_hop_s']
                t.insert(tk.END, "  Frame Hop: ", "key")
                t.insert(tk.END, f"{hop:.4f}s ({hop*1000:.1f}ms, {1/hop:.0f} fps)\n", "value")
            if 'fine_dims' in d.f0_config:
                t.insert(tk.END, "  Fine Dims: ", "key")
                t.insert(tk.END, f"{d.f0_config['fine_dims']}\n", "value")

        t.insert(tk.END, "\n═══ RESUMEN DE SECCIONES ═══\n\n", "header")
        summary = d.get_section_summary()
        t.insert(tk.END, f"  {'Sección':<15} {'Ocurrencias':>12} {'Tamaño total':>14}\n", "dim")
        t.insert(tk.END, f"  {'─'*15} {'─'*12} {'─'*14}\n", "dim")
        for name, count, size in summary:
            name_display = name if name else "(header)"
            t.insert(tk.END, f"  {name_display:<15} ", "key")
            t.insert(tk.END, f"{count:>12}   {size:>10,} B\n", "value")

        total_prim4 = sum(s for n, c, s in summary if n == 'prim4')
        t.insert(tk.END, f"\n  Datos modelo (prim4): ", "key")
        t.insert(tk.END, f"{total_prim4:,} bytes ({total_prim4/1024/1024:.2f} MB) — {total_prim4/d.total_size*100:.1f}% del archivo\n", "value")

        t.config(state=tk.DISABLED)

    # ─────────────── Structure tab ───────────────

    def _populate_structure(self):
        tree = self.struct_tree
        tree.delete(*tree.get_children())
        for m in self.dnni.markers:
            hex_preview = ' '.join(f'{b:02X}' for b in m.data_bytes[:32])
            if m.size > 32:
                hex_preview += " ..."
            name_display = m.name if m.name else "(header)"
            tree.insert("", tk.END, values=(
                f"0x{m.offset:06X}",
                f"0x{m.typ:02X}",
                name_display,
                f"{m.size:,} B",
                hex_preview
            ))

    # ─────────────── Phonemes tab ───────────────

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
        tree = self.phone_tree
        tree.delete(*tree.get_children())
        for i, phone in enumerate(ps.phones):
            cat = ps.categories[i] if i < len(ps.categories) else "—"
            tree.insert("", tk.END, values=(i, phone, cat))

    # ─────────────── F0 Editor ───────────────

    def _get_f0_range(self):
        """Rango de frecuencias para el canvas."""
        return (60, 1200)  # C2 ~ C6

    def _canvas_to_f0(self, x, y):
        """Convierte coordenadas del canvas a (time_s, freq_hz)."""
        w = self.f0_canvas.winfo_width()
        h = self.f0_canvas.winfo_height()
        if w <= 0 or h <= 0:
            return (0, 440)
        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0
        f_min, f_max = self._get_f0_range()

        time_s = (x / w) * dur
        # Escala logarítmica para frecuencia
        log_min = math.log2(f_min)
        log_max = math.log2(f_max)
        log_freq = log_max - (y / h) * (log_max - log_min)
        freq = 2 ** log_freq

        return (time_s, freq)

    def _f0_to_canvas(self, time_s, freq_hz):
        """Convierte (time_s, freq_hz) a coordenadas del canvas."""
        w = self.f0_canvas.winfo_width()
        h = self.f0_canvas.winfo_height()
        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0
        f_min, f_max = self._get_f0_range()

        x = (time_s / dur) * w
        log_min = math.log2(f_min)
        log_max = math.log2(f_max)
        if freq_hz <= 0:
            freq_hz = f_min
        log_freq = math.log2(freq_hz)
        y = h - ((log_freq - log_min) / (log_max - log_min)) * h

        return (x, y)

    def _on_canvas_click(self, event):
        t, f = self._canvas_to_f0(event.x, event.y)
        self.f0_points.append((t, f))
        self.f0_points.sort(key=lambda p: p[0])
        self._redraw_f0()

    def _on_canvas_drag(self, event):
        t, f = self._canvas_to_f0(event.x, event.y)
        self.f0_points.append((t, f))
        self.f0_points.sort(key=lambda p: p[0])
        self._redraw_f0()

    def _on_canvas_right_click(self, event):
        if not self.f0_points:
            return
        # Borrar punto más cercano
        t, f = self._canvas_to_f0(event.x, event.y)
        closest = min(range(len(self.f0_points)),
                      key=lambda i: abs(self.f0_points[i][0] - t) + abs(math.log2(max(self.f0_points[i][1],1)) - math.log2(max(f,1))))
        self.f0_points.pop(closest)
        self._redraw_f0()

    def _redraw_f0(self, event=None):
        c = self.f0_canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()
        if w <= 1 or h <= 1:
            return

        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0
        f_min, f_max = self._get_f0_range()

        # Grid de notas
        for octave in range(2, 7):
            for note_idx, note_name in enumerate(NOTE_NAMES):
                freq = note_to_freq(note_name, octave)
                if f_min <= freq <= f_max:
                    _, y = self._f0_to_canvas(0, freq)
                    is_c = note_idx == 0
                    color = "#45475a" if is_c else "#313244"
                    width = 2 if is_c else 1
                    c.create_line(0, y, w, y, fill=color, width=width)
                    if is_c or note_name in ('E', 'G', 'A'):
                        c.create_text(5, y - 8, text=f"{note_name}{octave}", fill="#6c7086",
                                     anchor=tk.W, font=("Consolas", 8))

        # Grid temporal
        step = 0.5 if dur <= 8 else 1.0
        t = 0
        while t <= dur:
            x = (t / dur) * w
            c.create_line(x, 0, x, h, fill="#313244", width=1)
            c.create_text(x + 3, h - 12, text=f"{t:.1f}s", fill="#6c7086",
                         anchor=tk.W, font=("Consolas", 8))
            t += step

        # Dibujar curva F0
        if len(self.f0_points) >= 2:
            coords = []
            for t, f in sorted(self.f0_points, key=lambda p: p[0]):
                x, y = self._f0_to_canvas(t, f)
                coords.extend([x, y])
            c.create_line(*coords, fill="#f38ba8", width=2, smooth=True)

        # Dibujar puntos
        for t, f in self.f0_points:
            x, y = self._f0_to_canvas(t, f)
            r = 5
            c.create_oval(x-r, y-r, x+r, y+r, fill="#89b4fa", outline="#cdd6f4", width=1)
            note = freq_to_note(f)
            c.create_text(x, y - 12, text=f"{note}", fill="#a6e3a1", font=("Consolas", 8))

        self.status_var.set(f"F0 Editor: {len(self.f0_points)} puntos | Duración: {dur}s")

    def _gen_scale(self):
        """Genera una escala ascendente."""
        self.f0_points.clear()
        note = self.base_note.get()
        octave = int(self.base_octave.get())
        scale_name = self.scale_combo.get()
        intervals = SCALES.get(scale_name, SCALES["Mayor (Ionian)"])
        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0

        base_midi = (octave + 1) * 12 + NOTE_NAMES.index(note)
        n_notes = len(intervals) + 1  # +1 para la octava superior
        note_dur = dur / n_notes

        for i in range(n_notes):
            if i < len(intervals):
                midi = base_midi + intervals[i]
            else:
                midi = base_midi + 12  # Octava
            freq = 440.0 * (2 ** ((midi - 69) / 12.0))
            t = i * note_dur
            self.f0_points.append((t, freq))
            self.f0_points.append((t + note_dur * 0.9, freq))

        self._redraw_f0()

    def _gen_random_melody(self):
        """Genera una melodía aleatoria basada en la escala seleccionada."""
        import random
        self.f0_points.clear()
        note = self.base_note.get()
        octave = int(self.base_octave.get())
        scale_name = self.scale_combo.get()
        intervals = SCALES.get(scale_name, SCALES["Pentatónica Menor"])
        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0

        base_midi = (octave + 1) * 12 + NOTE_NAMES.index(note)

        # Generar 8-16 notas aleatorias
        n_notes = random.randint(8, 16)
        note_dur = dur / n_notes

        # Pool de notas: 2 octavas
        pool = []
        for oct_shift in range(-1, 2):
            for iv in intervals:
                pool.append(base_midi + iv + oct_shift * 12)
        pool = [m for m in pool if 36 <= m <= 84]  # C2 a C6

        prev_midi = base_midi
        for i in range(n_notes):
            # Preferir notas cercanas a la anterior
            weights = [1.0 / (1 + abs(m - prev_midi)) for m in pool]
            midi = random.choices(pool, weights=weights, k=1)[0]

            freq = 440.0 * (2 ** ((midi - 69) / 12.0))
            t = i * note_dur
            # Añadir ligero vibrato
            self.f0_points.append((t, freq))
            self.f0_points.append((t + note_dur * 0.85, freq))

            prev_midi = midi

        self._redraw_f0()

    def _clear_f0(self):
        self.f0_points.clear()
        self._redraw_f0()

    def _export_wav(self):
        if not self.f0_points:
            messagebox.showwarning("Sin datos", "Dibuja una curva F0 primero.")
            return

        path = filedialog.asksaveasfilename(
            title="Guardar WAV",
            defaultextension=".wav",
            filetypes=[("WAV Audio", "*.wav")],
            initialdir=os.path.dirname(__file__),
            initialfile="f0_melody.wav"
        )
        if not path:
            return

        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0

        self.status_var.set("Generando WAV...")
        self.update()

        def generate():
            try:
                F0Synthesizer.generate_sine_wav(self.f0_points, dur, path)
                self.after(0, lambda: self.status_var.set(f"WAV guardado: {path}"))
                self.after(0, lambda: messagebox.showinfo("Exportado", f"Audio guardado en:\n{path}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))

        threading.Thread(target=generate, daemon=True).start()

    def _play_audio(self):
        """Genera y reproduce el audio."""
        if not self.f0_points:
            messagebox.showwarning("Sin datos", "Dibuja una curva F0 primero.")
            return

        try:
            dur = float(self.duration_var.get())
        except:
            dur = 4.0

        temp_path = os.path.join(os.path.dirname(__file__), "_temp_preview.wav")
        self.status_var.set("Generando preview...")
        self.update()

        def play():
            try:
                F0Synthesizer.generate_sine_wav(self.f0_points, dur, temp_path)
                # Reproducir con el sistema
                os.startfile(temp_path)
                self.after(0, lambda: self.status_var.set("Reproduciendo..."))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))

        threading.Thread(target=play, daemon=True).start()


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    app = DnniExplorer()
    app.mainloop()

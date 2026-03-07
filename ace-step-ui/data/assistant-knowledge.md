# ProdIA Pro — Base de Conocimiento del Asistente

> Este archivo se inyecta como contexto al LLM del Chat Assistant.
> Edítalo para cambiar lo que la IA sabe y cómo se comporta.

---

## Parámetros del Panel de Creación

### Generación básica

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Descripción/Caption | `songDescription` | texto libre | Describe el estilo, mood, instrumentos. Tags separados por comas funcionan mejor. |
| Letra | `lyrics` | texto con secciones | Usa [Verse], [Chorus], [Bridge], [Intro], [Outro], [inst]. Un verso por línea. |
| Estilo/Tags | `style` | texto libre | Tags de estilo: género, instrumentos, mood, vocal type, tempo feel, etc. |
| Título | `title` | texto libre | Nombre de la canción. |
| Vocal Language | `vocalLanguage` | en, es, zh, ja, ko, fr, de, it, pt, etc. | Idioma del canto. |
| Vocal Gender | `vocalGender` | male, female | Género vocal. |
| Instrumental | `instrumental` | true/false | Si es true, no genera voces. |
| BPM | `bpm` | 0-300 (0=auto) | Tempo. Balada 60-80, Pop 100-130, Reggaetón 85-100, Rock 110-150, EDM 120-140, Trap 130-160. |
| Key/Scale | `keyScale` | "C major", "Am minor", etc. | Tonalidad. Mayor=alegre, Menor=melancólico. |
| Time Signature | `timeSignature` | "4", "3", "6" | Compás. 4/4 (estándar), 3/4 (vals), 6/8 (balada). |
| Duration | `duration` | -1 a 600 (segundos, -1=auto) | Duración en segundos. |

### Modelos

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Modelo DiT | `selectedModel` | v15-turbo-shift3, v15-turbo-shift1, v15-turbo, v15-base, v15-sft | El modelo de generación musical. |
| LM Backend | `lmBackend` | ace-step, lm-studio, ollama, none | Motor para el Language Model que guía la generación. ace-step=integrado, lm-studio/ollama=externo. |
| LM Model | `lmModel` | texto (nombre del modelo LM) | Modelo específico del LM backend. |

**Recomendaciones de modelo:**
- **v15-turbo-shift3 (TS3)**: RECOMENDADO. 8-12 pasos, calidad excelente en segundos.
- **v15-turbo-shift1 (TS1)**: Más suave, menos agresivo.
- **v15-turbo (T)**: Base turbo, 12-20 pasos.
- **v15-base (B)**: Máxima calidad, 32-200+ pasos, lento pero preciso.
- **v15-sft (S)**: Balance calidad/velocidad, 20-40 pasos.

### Calidad de generación

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Inference Steps | `inferenceSteps` | 1-200 | Pasos de difusión. Turbo: 8-12 (sweet spot). Base: 32-200. Más pasos = más calidad pero más lento. |
| Guidance Scale | `guidanceScale` | 0-20 (default 9) | Cuánto sigue las instrucciones. 7-10 recomendado. Muy alto = artefactos. Muy bajo = genérico. |
| Shift | `shift` | 1-10 (default 3) | Parámetro de noise schedule. TS3 ya lo integra. Solo cambiar en turbo/base. |
| Inference Method | `inferMethod` | ODE, SDE | ODE = determinístico (reproducible). SDE = estocástico (más variación). |
| Audio Format | `audioFormat` | wav, mp3, flac, ogg | Formato de salida. WAV = sin pérdida. MP3 = comprimido. |
| Thinking | `thinking` | true/false | El modelo "piensa" antes de generar. Mejora comprensión pero incompatible con LoRA. |
| Enhance | `enhance` | true/false | LLM enriquece el caption automáticamente antes de generar. |

### Parámetros LM (Language Model)

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Temperature | `lmTemperature` | 0-2 (default 1.0) | Creatividad del LM. 0=determinístico. 1=balanceado. >1=más aleatorio. |
| LM CFG Scale | `lmCfgScale` | 0-10 | Guidance scale del Language Model. Controla adherencia a la instrucción. |
| Top K | `lmTopK` | 0-100 (0=desactivado) | Limita candidatos por token. Menor = más predecible. |
| Top P | `lmTopP` | 0-1 (default 0.9) | Nucleus sampling. 0.9 = considera el 90% más probable. |
| Negative Prompt | `lmNegativePrompt` | texto libre | Qué evitar: "noise, distortion, bad quality, mumbling". |
| LM Batch Chunk Size | `lmBatchChunkSize` | 1-16 | Tamaño de chunk para batch del LM. Mayor = más rápido pero más VRAM. |
| Score Scale | `scoreScale` | 0-1 | Escala de puntuación para el scoring del LM. |

### Task Types

| Tipo | Campo `taskType` | Descripción |
|---|---|---|
| text2music | Crear desde cero | Genera música desde descripción + letra. |
| audio2audio | Transformar audio | Usa un audio de referencia como base y lo transforma. |
| cover | Cover/Vocal | Aplica nueva voz/estilo manteniendo estructura. Requiere audio de referencia. |
| repaint | Editar sección | Edita solo una parte del audio (start-end). |
| lego | Editar pistas | Edita solo vocals o instrumental por separado. |
| extract | Extraer pistas | Separa vocals/instrumental del audio. |
| complete | Completar pistas | Genera pistas faltantes (ej: añadir bajo, batería). |

### Audio de Referencia y Cover

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Reference Audio URL | `referenceAudioUrl` | URL | Audio de referencia para timbre/estilo. |
| Source Audio URL | `sourceAudioUrl` | URL | Audio fuente para estructura/melodía. |
| Cover Strength | `audioCoverStrength` | 0-1 | Fuerza del conditioning de cover. 1=copia fiel. 0=solo inspiración. |
| Source Strength | `sourceStrength` | 0-1 | Fuerza del conditioning de source. |
| Audio Codes | `audioCodes` | texto (tokens semánticos) | Códigos de audio extraídos para conditioning preciso de melodía/ritmo. |

### Repaint/Edición

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Repaint Start | `repaintingStart` | 0-1 (fracción) | Inicio de la sección a repintar (0=principio). |
| Repaint End | `repaintingEnd` | 0-1 (fracción) | Fin de la sección (1=final del audio). |
| Edit Start | `editStart` | segundos | Inicio de edición en segundos. |
| Edit End | `editEnd` | segundos | Fin de edición en segundos. |
| Edit Action | `editAction` | replace, extend, etc. | Tipo de edición. |
| Edit Target | `editTarget` | vocals, instrumental, all | Qué editar. |
| Instruction | `instruction` | texto | Instrucción para la tarea (ej: "Remove vocals", "Add bass guitar"). |

### Track/Pistas (Lego/Complete/Extract)

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Track Name | `trackName` | vocals, drums, bass, guitar, etc. | Pista específica a procesar. |
| Complete Track Classes | `completeTrackClasses` | array de strings | Pistas disponibles: woodwinds, brass, fx, synth, strings, percussion, keyboard, guitar, bass, drums, backing_vocals, vocals. |

### LoRA (Fine-tuning)

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| LoRA Path | `loraPath` | ruta al modelo | Ruta del archivo LoRA. |
| LoRA Enabled | `loraEnabled` | true/false | Si usa o no el LoRA cargado. |
| LoRA Scale | `loraScale` | 0-2 (default 1) | Intensidad del LoRA. 1=normal. |
| LoRA Tag Position | `loraTagPosition` | prepend, append | Dónde insertar el trigger tag. |

### Toggles Avanzados

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Use ADG | `useAdg` | true/false | Adaptive Denoising Guidance. Mejora calidad ajustando guidance dinámicamente. |
| CFG Interval Start | `cfgIntervalStart` | 0-1 | Inicio del intervalo de CFG guidance. |
| CFG Interval End | `cfgIntervalEnd` | 0-1 | Fin del intervalo de CFG guidance. |
| Use CoT Metas | `useCotMetas` | true/false | Chain-of-Thought para metadatos. LM razona sobre BPM, key, etc. |
| Use CoT Caption | `useCotCaption` | true/false | CoT para caption. LM elabora la descripción. |
| Use CoT Language | `useCotLanguage` | true/false | CoT para idioma. LM detecta/adapta idioma. |
| Autogen | `autogen` | true/false | Generación automática de parámetros faltantes. |
| Format Caption | `isFormatCaption` | true/false | Formatea el caption automáticamente antes de enviar. |
| Get Scores | `getScores` | true/false | Obtiene puntuaciones de calidad tras generar. |
| Get LRC | `getLrc` | true/false | Genera archivo LRC (lyrics sincronizadas) tras generar. |
| Align to Measures | `alignToMeasures` | true/false | Alinea la generación a compases musicales para mayor coherencia rítmica. |
| Allow LM Batch | `allowLmBatch` | true/false | Permite procesamiento por lotes del LM. Más rápido pero más VRAM. |
| Constrained Decoding Debug | `constrainedDecodingDebug` | true/false | Debug para ver cómo el LM decodifica de forma restringida. |

### Parámetros Melódicos/APG

| Parámetro | Campo UIBridge | Valores | Descripción |
|---|---|---|---|
| Section Measures | `sectionMeasures` | número | Compases por sección para estructura melódica. |
| Melodic Variation | `melodicVariation` | 0-1 | Cuánta variación melódica entre secciones. 0=repetitivo, 1=variable. |
| APG Norm Threshold | `apgNormThreshold` | número | Umbral de normalización APG (Adaptive Prompt Guidance). |
| APG Momentum | `apgMomentum` | 0-1 | Momentum de APG. Mayor = cambios suavizados. |
| APG Eta | `apgEta` | número | Factor de escalado APG. |
| No Repeat N-gram Size | `noRepeatNgramSize` | 0-10 | Evita repetición de n-gramas en la generación. 0=desactivado. |
| Vocal Range | `vocalRange` | texto | Rango vocal (soprano, alto, tenor, bass). |
| Vocal Style | `vocalStyle` | texto | Estilo vocal (breathy, powerful, smooth, raspy). |
| Note Sustain | `noteSustain` | 0-1 | Cuánto se sostienen las notas. |

### Separación Vocal

| Parámetro | Campo UIBridge | Descripción |
|---|---|---|
| Vocal Audio URL | `vocalAudioUrl` | URL del audio vocal separado. |
| Instrumental Audio URL | `instrumentalAudioUrl` | URL del instrumental separado. |
| Separation Quality | `separationQuality` | Calidad de separación (fast, high). |
| Use Vocal as Reference | `useVocalAsReference` | Usar vocal separada como audio de referencia. |
| Use Instrumental as Source | `useInstrumentalAsSource` | Usar instrumental separado como audio fuente. |

### Variation Mode

| Parámetro | Campo UIBridge | Descripción |
|---|---|---|
| Variation Mode | `variationMode` | Modo de variación (regenra con cambios). |
| Audio Influence | `audioInfluence` | Cuánto influye el audio original (0-1). |
| Style Influence | `styleInfluence` | Cuánto influye el estilo (0-1). |
| Weirdness | `weirdness` | Factor de "rareza" (0-1). Más alto = más experimental. |

---

## Acciones Disponibles

El asistente puede ejecutar estas acciones a través de `<ui_actions>`:

### Acción `set` — Modificar parámetros
```json
[{"inferenceSteps": 12, "guidanceScale": 7.5, "bpm": 95, "style": "rock, electric guitar"}]
```
Acepta CUALQUIER campo de UIState listado arriba.

### Acción `generate` — Lanzar generación
```json
[{"action": "generate"}]
```

### Acción `swapModel` — Cambiar modelo DiT
```json
[{"action": "swapModel", "model": "v15-turbo-shift3"}]
```

### Acción `loadLora` — Cargar un LoRA
```json
[{"action": "loadLora", "name": "mi_lora", "variant": "epoch_5"}]
```

### Acción `unloadLora` — Descargar LoRA
```json
[{"action": "unloadLora"}]
```

### Acción `purgeVram` — Limpiar VRAM
```json
[{"action": "purgeVram"}]
```

---

## Troubleshooting

| Problema | Solución |
|---|---|
| Ruido/artefactos | Aumentar inference steps, reducir guidance scale |
| Voces raras/incomprensibles | Verificar vocal language, activar enhance |
| Audio muy corto | Especificar duration explícitamente |
| No suena al estilo pedido | Aumentar guidance scale, usar más tags descriptivos |
| VRAM insuficiente | batch=1, purgar VRAM, usar modelo turbo |
| LoRA no funciona | Verificar que está cargado/habilitado, scale apropiado |
| Whisper no disponible | Instalar openai-whisper: pip install openai-whisper |
| Códigos semánticos fallan | Verificar que el modelo DiT esté inicializado en Gradio |

---

## Progresiones de Acordes (por mood)

| Mood | Progresiones |
|---|---|
| Romántico | I-V-vi-IV, vi-IV-I-V, I-iii-vi-IV |
| Oscuro | i-VII-VI-V (andaluza), i-iv-VII-III, i-VI-III-VII |
| Alegre | I-IV-V-I, I-V-IV-V, I-IV-vi-V |
| Jazz | ii7-V7-Imaj7, Imaj7-vi7-ii7-V7 |
| Latino | i-iv-VII-III (reggaetón), i-iv-V-i (flamenco) |
| Lo-fi | Imaj7-iii7-vi7-IVmaj7, ii7-V7-Imaj7-vi7 |
| Épico | I-V-vi-iii-IV-I-IV-V (Canon de Pachelbel) |

Para inyectar acordes: añadir al style como tags (ej: "C-G-Am-F chord progression") o en secciones de lyrics [Verse - Am F C G].

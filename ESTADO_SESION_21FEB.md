# Estado de Sesión - 21 Febrero 2026 (Capturas Gradio)

## Gradio Running
- **Puerto**: 7860
- **PID**: 12392
- **URL**: http://127.0.0.1:7860

---

## Step 1: Dataset Builder - Load Existing Dataset
- **Dataset JSON Path**: `./datasets/my_lora_dataset.json`
  - Ruta absoluta: `D:\espacios de trabajo\vscode\acestep\ACE-Step-1.5_\datasets\my_lora_dataset.json`
- **Load Status**: ❌ "Please enter a dataset path" (no se había cargado desde JSON, se hizo Scan)

## Step 1: Dataset Builder - Scan New Directory
- **Audio Directory Path**: `D:\espacios de trabajo\vscode\acestep\ACE-Step-1.5_\datasets\urban_flow\dataset_IA`
- **Scan Status**: ✅ Found 58 audio files

---

## Dataset Settings (Captura 2)
| Setting              | Value                          |
|----------------------|--------------------------------|
| **Dataset Name**     | `Urban_Walki_V3`               |
| **All Instrumental** | ❌ (unchecked)                 |
| **Format Lyrics (LM)** | ❌ (unchecked)              |
| **Transcribe Lyrics (LM)** | ❌ (unchecked)          |
| **Custom Activation Tag** | `Walki-bass`              |
| **Tag Position**     | `Prepend (tag, caption)`       |
| **Genre Ratio (%)**  | `40`                           |

---

## Step 2: Auto-Label
- **Estado**: ✅ Labeled 58/58 samples

---

## Step 3: Preview & Edit (Captura 3 - Sample #14 = 23.wav)
| Campo               | Valor                          |
|---------------------|--------------------------------|
| **Select Sample #** | 14                             |
| **Filename**        | `23.wav`                       |
| **Caption**         | A romantic trap blues track driven by a warm overdriven electric guitar melody, deep 808 bass and a hybrid drum kit blending organic snare with crisp trap hi-hats. Features breathy languid female vocals with a sultry, effortless delivery that shifts between melancholic softness and bursts of emotional intensity. |
| **Genre**           | romantic trap, trap blues, breathy female vocals, overdriven guitar, 808 bass, melancholic, bittersweet |
| **Prompt Override** | Use Global Ratio               |
| **BPM**             | 78                             |
| **Key**             | G minor                        |
| **Time Signature**  | 3                              |
| **Duration (s)**    | 156                            |
| **Language**        | es                             |
| **Instrumental**    | ❌ (unchecked)                 |
| **Lyrics**          | (letras en español - Chorus/Bridge/Chorus con "Y yo siento la vida, Pasando rápido...") |
| **Edit Status**     | ✅ Updated: 23.wav             |

---

## Step 4: Save Dataset (Captura 4)
- **Save Path**: `./datasets/Continuar.json`
  - Ruta absoluta sería: `D:\espacios de trabajo\vscode\acestep\ACE-Step-1.5_\datasets\Continuar.json`
- **¿Guardado?**: ⚠️ NO VERIFICADO - El archivo Continuar.json NO existía al momento de la captura

---

## Configuración .env (ACE-Step-1.5_/.env)
```
ACESTEP_CONFIG_PATH=acestep-v15-turbo
ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B
ACESTEP_DEVICE=auto
ACESTEP_LM_BACKEND=vllm
```

---

## Tabla de muestras visibles (Captura 2)
| #  | Filename | Duration | Lyrics | Labeled | BPM | Key     | Caption (preview)                    |
|----|----------|----------|--------|---------|-----|---------|--------------------------------------|
| 38 | 57.wav   | 203.0s   | -      | ✅      | 140 | minor   | pop trac built on a steady m...      |
| 39 | 6.wav    | 181.0s   | -      | ✅      | 100 | E minor | An intense, cinematic intro with dramatic synth st... |
| 40 | 61.mp3   | 168.0s   | -      | ✅      | 100 | B minor | A dreamy atmospheric intro with shimmering synth... |

---

## Progreso de edición manual
- **Samples editados manualmente**: ~14-15 (del 0 al 14)
- **Samples restantes**: ~43-44
- **Total samples**: 58

---

## Archivos importantes
| Archivo | Ruta | Estado |
|---------|------|--------|
| Dataset JSON original | `ACE-Step-1.5_/datasets/my_lora_dataset.json` | Última escritura: 21 Feb 3:27 AM |
| Dataset Continuar | `ACE-Step-1.5_/datasets/Continuar.json` | ⚠️ PENDIENTE de guardar |
| Script truncar captions | `truncar_captions.py` | ✅ Creado y probado |
| Singer Library Spec | `SINGER_LIBRARY_SPEC.md` | ✅ Completo |
| Audio files | `ACE-Step-1.5_/datasets/urban_flow/dataset_IA/` | 58 archivos |

---

## Para continuar mañana
1. Abrir terminal → ejecutar `iniciar_acestep.bat` → opción 1 (Gradio UI)
2. En Gradio → "Load Existing Dataset" → poner la ruta del JSON guardado
3. Click "Load" → se cargan los 58 samples con las ediciones hechas
4. Continuar editando desde sample ~15 en adelante
5. Al terminar todas las ediciones → "Save Dataset"
6. Ejecutar `truncar_captions.py` para recortar captions a 2 frases
7. Step 5: Preprocess to tensors
8. Step 6: Train LoRA

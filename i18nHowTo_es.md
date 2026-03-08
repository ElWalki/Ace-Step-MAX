# Guía para Desarrolladores: Internacionalización (i18n)

Este proyecto utiliza un sistema estandarizado de internacionalización (i18n) tanto para el frontend en React como para los componentes del backend en Python.

## 1. Frontend en React (ace-step-ui)

El frontend utiliza `i18next` y `react-i18next`.

### Añadir Nuevas Traducciones
1. Abre los archivos de configuración regional en `ace-step-ui/i18n/locales/` (ej. `en.json`, `es.json`).
2. Añade tus pares clave-valor. Utiliza claves descriptivas.
   ```json
   {
     "myNewFeature": "Mi Nueva Función",
     "welcomeMessage": "¡Hola, {{name}}!"
   }
   ```

### Usar Traducciones en Componentes
Utiliza el hook `useTranslation` de `react-i18next`.

```tsx
import { useTranslation } from 'react-i18next';

export function MyComponent() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('myNewFeature')}</h1>
      <p>{t('welcomeMessage', { name: 'Usuario' })}</p>
    </div>
  );
}
```

### Cambio de Idioma
El `I18nProvider` gestiona la sincronización con `localStorage` y detecta el idioma del navegador automáticamente.

---

## 2. Backend en Python

El backend utiliza una utilidad personalizada ligera ubicada en `i18n/utils.py`.

### Añadir Nuevas Traducciones
1. Abre los archivos de configuración regional del backend en `i18n/locales/` (ej. `en.json`, `es.json`).
2. Añade tus claves:
   ```json
   {
     "processing_file": "Procesando archivo: {path}",
     "done": "Hecho"
   }
   ```

### Usar Traducciones en Scripts
Importa la función `t` de la utilidad i18n.

```python
import os
import sys
# Asegúrate de que la raíz esté en el path si se ejecuta desde subdirectorios
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from i18n.utils import t

print(t('processing_file', path="cancion.mp3"))
print(t('done', default="¡Finalizado!"))
```

### Características
- **Detección Automática**: Utiliza `locale.getdefaultlocale()` para identificar el idioma del sistema.
- **Respaldo (Fallbacks)**: Cambia automáticamente a inglés (`en.json`) si falta una clave o un archivo de idioma.
- **Interpolación**: Soporta marcadores de posición estándar de Python estilo `.format()` (ej. `{path}`).

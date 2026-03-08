# Developer Guide: Internationalization (i18n)

This project uses a standardized internationalization (i18n) system for both the React frontend and Python backend components.

## 1. React Frontend (ace-step-ui)

The frontend uses `i18next` and `react-i18next`.

### Adding New Translations
1. Open the locale files in `ace-step-ui/i18n/locales/` (e.g., `en.json`, `es.json`).
2. Add your key-value pairs. Use descriptive keys.
   ```json
   {
     "myNewFeature": "My New Feature",
     "welcomeMessage": "Hello, {{name}}!"
   }
   ```

### Using Translations in Components
Use the `useTranslation` hook from `react-i18next`.

```tsx
import { useTranslation } from 'react-i18next';

export function MyComponent() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('myNewFeature')}</h1>
      <p>{t('welcomeMessage', { name: 'User' })}</p>
    </div>
  );
}
```

### Language Switching
The `I18nProvider` handles synchronization with `localStorage` and detects the browser's language automatically.

---

## 2. Python Backend

The backend uses a lightweight custom utility located in `i18n/utils.py`.

### Adding New Translations
1. Open the backend locale files in `i18n/locales/` (e.g., `en.json`, `es.json`).
2. Add your keys:
   ```json
   {
     "processing_file": "Processing file: {path}",
     "done": "Done"
   }
   ```

### Using Translations in Scripts
Import the `t` function from the i18n utility.

```python
import os
import sys
# Ensure root is in path if running from subdirectories
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from i18n.utils import t

print(t('processing_file', path="song.mp3"))
print(t('done', default="Finished!"))
```

### Features
- **Automatic Detection**: Uses `locale.getdefaultlocale()` to identify the system language.
- **Fallbacks**: Automatically falls back to English (`en.json`) if a key or locale file is missing.
- **Interpolation**: Supports standard Python `.format()` style placeholders (e.g., `{path}`).

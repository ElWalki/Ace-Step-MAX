# ACE-Step UI — Internationalization Guide

## Overview

The project supports 5 languages: English (default), Spanish, Chinese, Japanese, and Korean.

## Architecture

The project now uses `i18next` and `react-i18next` for robust internationalization.

```
ace-step-ui/
├── i18n/
│   ├── index.ts                 # i18next initialization
│   └── locales/                 # JSON translation files
│       ├── en.json
│       ├── es.json
│       ├── zh.json
│       ├── ja.json
│       └── ko.json
├── context/
│   └── I18nContext.tsx          # Wrapper for I18nextProvider + backward-compatible useI18n hook
└── components/                   # i18n-enabled components
```

## Usage

### 1. Use translations in a component

You can use either the standardized `useTranslation` hook from `react-i18next` or the existing `useI18n` hook for backward compatibility.

**Using `useTranslation` (Recommended):**
```tsx
import { useTranslation } from 'react-i18next';

function YourComponent() {
  const { t } = useTranslation();
  return <div>{t('yourTranslationKey')}</div>;
}
```

**Using `useI18n` (Legacy Support):**
```tsx
import { useI18n } from '../context/I18nContext';

function YourComponent() {
  const { t } = useI18n();
  return <div>{t('yourTranslationKey')}</div>;
}
```

### 2. Switch language

Users can switch language in Settings. Programmatically:

```tsx
const { language, setLanguage } = useI18n();
// or use i18n.changeLanguage() from useTranslation()
setLanguage('en'); // 'en' | 'es' | 'zh' | 'ja' | 'ko'
```

### 3. Add a new translation key

Add the key to all 5 JSON files in `i18n/locales/`:

**en.json**
```json
{ "yourNewKey": "English text" }
```

**es.json**
```json
{ "yourNewKey": "Texto en español" }
```

## Language Persistence

The selected language is stored in `localStorage` (via `i18next-browser-languagedetector`) and restored on next visit. Default is English or system language.

## Notes

- New keys should be added to **all** JSON files to ensure consistency.
- If a key is missing, `i18next` will return the raw key name and show a warning in development.
- For dynamic translations, use `t('key', { variable: 'value' })` and `{{variable}}` in the JSON files.

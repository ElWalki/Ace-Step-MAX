import json
import os
import locale

class I18n:
    def __init__(self, locale_dir=None, default_lang='en'):
        if locale_dir is None:
            # Try to find locales relative to this file
            base_dir = os.path.dirname(os.path.abspath(__file__))
            self.locale_dir = os.path.join(base_dir, 'locales')
        else:
            self.locale_dir = locale_dir
            
        self.default_lang = default_lang
        # Mode: 'en', 'es', or 'bilingual' (default)
        self.mode = os.environ.get('I18N_MODE', 'bilingual')
        self.current_lang = self._get_system_lang()
        
        self.trans_cache = {}
        self._load_all()

    def _get_system_lang(self):
        try:
            lang, _ = locale.getdefaultlocale()
            if lang:
                return lang.split('_')[0]
        except:
            pass
        return self.default_lang

    def _load_all(self):
        for lang in ['en', 'es']:
            file_path = os.path.join(self.locale_dir, f"{lang}.json")
            if os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        self.trans_cache[lang] = json.load(f)
                except Exception as e:
                    print(f"Error loading {lang} translations: {e}")
            else:
                self.trans_cache[lang] = {}

    def t(self, key, **kwargs):
        """
        Translates a key. 
        If mode is 'bilingual', returns "[ES] Spanish / [EN] English"
        """
        es = self.trans_cache.get('es', {}).get(key, key)
        en = self.trans_cache.get('en', {}).get(key, key)
        
        # Apply formatting if kwargs provided
        if kwargs:
            try:
                es = es.format(**kwargs)
                en = en.format(**kwargs)
            except:
                pass

        if self.mode == 'bilingual':
            if es == en: return es
            return f"{es} / {en}"
        elif self.mode == 'es':
            return es
        else:
            return en

# Global instances
_i18n = I18n()
t = _i18n.t

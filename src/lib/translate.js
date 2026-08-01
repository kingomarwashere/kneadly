// Auto-translate owner-entered content (service names/descriptions, tagline,
// about) into the customer's language via Workers AI, cached in D1. Best-effort:
// any failure returns the original text, so pages never break.

const LANG_NAMES = { en: 'english', th: 'thai', zh: 'chinese', vi: 'vietnamese', ko: 'korean', ja: 'japanese' }

function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) }

export async function translate(env, text, lang) {
  const src = text == null ? '' : String(text)
  const trimmed = src.trim()
  if (!trimmed || lang === 'en' || !LANG_NAMES[lang] || !env.AI || !env.DB) return src
  const key = hash(trimmed)
  try {
    const cached = await env.DB.prepare('SELECT translated FROM translations WHERE lang=? AND src_hash=?').bind(lang, key).first()
    if (cached) return cached.translated
    const res = await env.AI.run('@cf/meta/m2m100-1.2b', { text: trimmed, source_lang: 'english', target_lang: LANG_NAMES[lang] })
    const out = res && res.translated_text ? res.translated_text.trim() : ''
    if (out && out !== trimmed) {
      await env.DB.prepare('INSERT OR IGNORE INTO translations (lang, src_hash, src, translated) VALUES (?, ?, ?, ?)')
        .bind(lang, key, trimmed.slice(0, 400), out).run()
      return out
    }
    return src
  } catch (e) {
    console.error('translate failed:', String(e))
    return src
  }
}

export const translateAll = (env, texts, lang) => Promise.all(texts.map(t => translate(env, t, lang)))

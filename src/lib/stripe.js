export function stripeClient(secretKey) {
  const baseHeaders = { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }

  async function req(method, path, data) {
    const url = `https://api.stripe.com/v1${path}`
    const opts = { method, headers: baseHeaders }
    if (data) opts.body = new URLSearchParams(flattenParams(data)).toString()
    const res = await fetch(url, opts)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message || `Stripe error ${res.status}`)
    return json
  }

  function flattenParams(obj, prefix = '') {
    const result = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue
      const key = prefix ? `${prefix}[${k}]` : k
      if (typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(result, flattenParams(v, key))
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (typeof item === 'object') Object.assign(result, flattenParams(item, `${key}[${i}]`))
          else result[`${key}[${i}]`] = item
        })
      } else {
        result[key] = String(v)
      }
    }
    return result
  }

  return {
    createCheckoutSession: (data) => req('POST', '/checkout/sessions', data),
    retrieveCheckoutSession: (id) => req('GET', `/checkout/sessions/${id}`),
    createRefund: (data) => req('POST', '/refunds', data),
    retrievePaymentIntent: (id) => req('GET', `/payment_intents/${id}`),
    async verifyWebhook(payload, sigHeader, secret) {
      const enc = new TextEncoder()
      const parts = sigHeader.split(',')
      const t = parts.find(p => p.startsWith('t=')).slice(2)
      const v1 = parts.find(p => p.startsWith('v1=')).slice(3)
      const signed = `${t}.${payload}`
      const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signed))
      const computed = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
      if (computed !== v1) throw new Error('Invalid webhook signature')
      return JSON.parse(payload)
    }
  }
}

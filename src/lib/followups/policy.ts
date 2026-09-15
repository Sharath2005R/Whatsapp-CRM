import type { MessageTemplate } from '@/types'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { renderTemplateBody } from '@/lib/whatsapp/template-body'

const SERVICE_TEXT: Record<string, string> = {
  en: 'This is the reminder you requested. Please reply here if you still need help.',
  hi: 'यह आपके अनुरोध पर भेजा गया रिमाइंडर है। सहायता चाहिए तो यहाँ जवाब दें।',
  kn: 'ನೀವು ಕೇಳಿದ ನೆನಪಿನ ಸಂದೇಶ ಇದು. ಸಹಾಯ ಬೇಕಿದ್ದರೆ ಇಲ್ಲಿ ಉತ್ತರಿಸಿ.',
}
export interface SendPlan {
  category: 'service' | 'utility'
  to: string
  phoneNumberId: string
  body: string
  template?: MessageTemplate
  language: string
  params: string[]
}
function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('Invalid follow-up content')
  return value
}

/** No model/customer body, category, template ID or variable mapping is accepted. */
export function prepareSendPlan(value: unknown): SendPlan {
  if (!value || typeof value !== 'object') throw new Error('Invalid preparation')
  const p = value as Record<string, unknown>
  const phoneNumberId = safeText(p.phone_number_id, 80)
  if (!/^\d+$/.test(phoneNumberId)) throw new Error('Invalid sender')
  const to = sanitizePhoneForMeta(safeText(p.to, 32))
  if (!isValidE164(to)) throw new Error('Invalid customer phone')
  const language = safeText(p.language, 12)
  if (!/^(en|hi|kn)(_[A-Z]{2})?$/.test(language)) throw new Error('Unsupported language')
  const base = language.split('_')[0]
  if (p.category === 'service') return { category: 'service', to, phoneNumberId, body: SERVICE_TEXT[base], language, params: [] }
  if (p.category !== 'utility' || !p.template || typeof p.template !== 'object') throw new Error('Unsupported category')
  const template = p.template as MessageTemplate
  if (template.category !== 'Utility' || template.status !== 'APPROVED' || template.language !== language ||
    !template.meta_template_id || !/^\d+$/.test(template.meta_template_id) || !/^[a-z0-9_]+$/.test(template.name) ||
    template.header_content || template.header_type || template.buttons?.length) throw new Error('Invalid Utility template')
  const body = safeText(template.body_text, 4096)
  if (!Array.isArray(p.variables) || p.variables.length > 2) throw new Error('Invalid template variables')
  const params = p.variables.map(key => {
    if (key !== 'customer_name' && key !== 'business_name') throw new Error('Unknown variable')
    return safeText(p[key], 100)
  })
  const placeholders = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]))
  if (body.replace(/\{\{\d+\}\}/g, '').match(/[{}]/) ||
    placeholders.some(n => n < 1 || n > params.length) ||
    params.some((_, i) => !placeholders.includes(i + 1))) throw new Error('Invalid variable mapping')
  return { category: 'utility', to, phoneNumberId, body: renderTemplateBody(body, params), template, language, params }
}

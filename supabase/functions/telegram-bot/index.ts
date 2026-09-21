// Telegram bot for your Open Brain.
// Runs on Supabase's servers as an Edge Function. Telegram posts every message
// sent to your bot here; this code saves it, searches, or lists recent thoughts.

import { createClient } from 'npm:@supabase/supabase-js@2'

// ---- secrets ---------------------------------------------------------------
// The first two are the ones you added under Edge Functions -> Secrets.
// The SUPABASE_ ones are handed to every function automatically.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '' // optional lock, added after first test
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service-role key skips the Level 2 security rule entirely, so this code
// must stamp and filter by OWNER_USER_ID itself on every query.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ---- talk back to Telegram --------------------------------------------------
async function sendMessage(chatId: number | string, text: string) {
  // Telegram limits messages to 4096 characters.
  const body = text.length > 4000 ? text.slice(0, 3990) + '\n…' : text
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
  })
}

function snippet(s: string, n = 300) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---- the three things the bot can do ---------------------------------------
async function saveThought(text: string, chatId: number) {
  const { error } = await db.from('thoughts').insert({
    content: '💬 ' + text,
    user_id: OWNER_USER_ID,
    metadata: { source: 'telegram', chat_id: chatId },
  })
  if (error) throw error
  return 'Saved to your brain ✓'
}

async function searchThoughts(query: string) {
  if (!query) return 'Tell me what to look for, e.g. /search lighting'
  const safe = query.replace(/[%_]/g, '\\$&')
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .ilike('content', `%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data || data.length === 0) return `Nothing in your brain matches "${query}".`
  return `Top ${data.length} for "${query}":\n\n` +
    data.map((t, i) => `${i + 1}. ${snippet(t.content)}\n   (${when(t.created_at)})`).join('\n\n')
}

async function recentThoughts() {
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data || data.length === 0) return 'Your brain is empty so far. Send me anything to save it.'
  return 'Your last 5 thoughts:\n\n' +
    data.map((t, i) => `${i + 1}. ${snippet(t.content)}\n   (${when(t.created_at)})`).join('\n\n')
}

const HELP =
  'I am your Open Brain.\n\n' +
  '• Send me anything and I save it.\n' +
  '• /search <word> or ?<word> — find thoughts\n' +
  '• /recent — your last 5 thoughts\n' +
  '• /help — this message'

// ---- entry point: Telegram calls this ---------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Whatever happens below, always answer 200 so Telegram does not keep retrying.
  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

  let chatId: number | undefined
  try {
    if (req.method !== 'POST') return ok()
    const update = await req.json()
    const msg = update.message ?? update.edited_message
    if (!msg || !msg.chat) return ok()
    chatId = msg.chat.id as number

    // Optional lock: once TELEGRAM_CHAT_ID is set, ignore everyone else.
    if (ALLOWED_CHAT_ID && String(chatId) !== ALLOWED_CHAT_ID) return ok()

    const text: string = (msg.text ?? msg.caption ?? '').trim()
    if (!text) { await sendMessage(chatId, 'I can only save text for now.'); return ok() }

    if (!OWNER_USER_ID) {
      await sendMessage(chatId, 'OWNER_USER_ID secret is missing in Supabase, so I cannot save yet.')
      return ok()
    }

    let reply: string
    if (text === '/start') {
      reply = HELP + `\n\nYour chat id is ${chatId}. Save it as the TELEGRAM_CHAT_ID secret to lock this bot to you.`
    } else if (text === '/help') {
      reply = HELP
    } else if (text.startsWith('/search')) {
      reply = await searchThoughts(text.slice(7).trim())
    } else if (text.startsWith('?')) {
      reply = await searchThoughts(text.slice(1).trim())
    } else if (text.startsWith('/recent')) {
      reply = await recentThoughts()
    } else {
      reply = await saveThought(text, chatId)
    }
    await sendMessage(chatId, reply)
  } catch (e) {
    console.error('telegram-bot error:', e)
    if (chatId) await sendMessage(chatId, 'Something went wrong: ' + (e as Error).message)
  }
  return ok()
})

// ============================================================================
// CAPTURE-YOUTUBE — paste a YouTube link; the server fetches the spoken
// transcript and saves it to your brain.
//
// WHY THIS FILE IS COMPLICATED — worth understanding before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre — which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code, it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. Fetches from residential IPs, so
//                    it gets real transcripts. Free tier covers ~100/month.
//                    Optional: with no key we skip straight to step 2.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the iPhone
//                    and Android apps, which YouTube serves properly even from
//                    a datacentre. No key needed, works often.
//   3. DESCRIPTION — if no captions exist anywhere, fall back to the title and
//                    description so you still capture something. Clearly
//                    labelled as such.
//
// This version saves the raw transcript. Level 5 adds an agent that summarises.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''   // optional

const CONTENT_PREVIEW = 6_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function decodeEntities(text: string): string {
  if (!text) return ''
  const map: Record<string, string> = {
    '&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&apos;':"'",'&nbsp;':' ',
    '&rsquo;':'\u2019','&lsquo;':'\u2018','&rdquo;':'\u201D','&ldquo;':'\u201C',
    '&mdash;':'\u2014','&ndash;':'\u2013','&hellip;':'\u2026',
    '&aacute;':'á','&eacute;':'é','&iacute;':'í','&oacute;':'ó','&uacute;':'ú','&ntilde;':'ñ','&uuml;':'ü',
    '&Aacute;':'Á','&Eacute;':'É','&Iacute;':'Í','&Oacute;':'Ó','&Uacute;':'Ú','&Ntilde;':'Ñ','&Uuml;':'Ü',
    '&iexcl;':'¡','&iquest;':'¿',
  }
  let out = text
  for (const k in map) out = out.split(k).join(map[k])
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  return out.split('&amp;').join('&')
}

interface VideoContent { content: string; hasTranscript: boolean; source: string }

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) { const m = url.match(p); if (m) return m[1] }
  return null
}

// Title via oEmbed — no key, essentially always works
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`, { signal: AbortSignal.timeout(8000) })
    if (res.ok) { const data = await res.json(); if (data?.title) return decodeEntities(data.title as string) }
  } catch { /* fall through */ }
  return `Video ${videoId}`
}

// ROUTE 1 — Supadata
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) { console.log(`[youtube] Supadata HTTP ${res.status} — falling through`); return null }
    const data = await res.json()
    const segments: Array<{ text?: string }> = data?.content ?? []
    const transcript = segments.map(s => s.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) { console.error('[youtube] Supadata error:', String(err)); return null }
}

// ROUTE 2 — Innertube (YouTube's internal app API), posing as the mobile apps
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    { name: 'IOS', userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: { clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone17,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US' } },
    { name: 'ANDROID', userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' } },
  ]
  // deno-lint-ignore no-explicit-any
  let best: any = null
  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) { console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`); continue }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) { best = result; break }
      if (!best) best = result   // keeps the description even without captions
    } catch (err) { console.error(`[youtube] Innertube ${client.name} error:`, String(err)) }
  }
  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const track = tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr')
        ?? tracks.find((t: any) => t.languageCode === 'en')
        ?? tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en'))
        ?? tracks[0]
      const capRes = await fetch(track.baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, signal: AbortSignal.timeout(12_000) })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => decodeEntities(m[1])).join(' ').replace(/\s+/g, ' ').trim()
        if (transcript) return { content: transcript, hasTranscript: true, source: 'innertube' }
      }
    }
    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(', ') ?? ''
    if (description || keywords) {
      return { content: [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n'), hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) { console.error('[youtube] Innertube parse error:', String(err)); return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  try {
    // Identify the caller from their login token — never from the request body.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube url is required' }, 400)
    const videoId = extractVideoId(url)
    if (!videoId) return json({ ok: false, error: 'That does not look like a YouTube link.' }, 400)

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) return json({ ok: false, error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked.' }, 422)

    const label = result.hasTranscript ? '' : '(Based on the video description — no transcript was available)\n\n'
    const preview = result.content.length > CONTENT_PREVIEW ? result.content.slice(0, CONTENT_PREVIEW) + '\n\n[… full text saved]' : result.content

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: thought, error: insErr } = await admin.from('thoughts').insert({
      user_id: user.id,
      content: `📹 YouTube: ${title}\n${videoUrl}\n\n${label}${preview}`,
      metadata: { source: 'youtube', title, video_id: videoId, video_url: videoUrl, has_transcript: result.hasTranscript, fetched_via: result.source },
    }).select('id').single()
    if (insErr) throw insErr

    // Non-fatal on failure — the thought is already saved either way.
    const { error: srcErr } = await admin.from('thought_sources').insert({
      thought_id: thought.id, user_id: user.id, source_text: result.content,
      source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: result.content.length, truncated: false,
    })
    if (srcErr) console.warn('[youtube] thought_sources insert failed:', srcErr.message)

    return json({ ok: true, title, has_transcript: result.hasTranscript, fetched_via: result.source, chars: result.content.length })
  } catch (err) {
    console.error('[youtube] Failed:', String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})

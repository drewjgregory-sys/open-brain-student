// ============================================================================
// CAPTURE-URL — paste any article link; the server fetches the page, strips it
// down to readable text, and saves it to your brain.
//
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages from
// other websites (that rule is called CORS, and it exists for good security
// reasons). A server has no such limit. So your app hands the link to this
// function, and this function does the fetching.
//
// This version saves the raw text. Level 5 adds an agent that summarises it.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const MAX_BYTES = 3_000_000        // refuse to swallow a 50 MB page
const CONTENT_PREVIEW = 6_000      // how much of the article goes in the thought itself

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Turn entity codes (&amp; &rsquo; &ntilde; ...) back into characters. &amp; last.
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

// Deliberately simple: strip the machinery (scripts, styles, navigation,
// footers), then remove the remaining tags. Handles articles and blog posts
// well; not perfect on every site.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token, never from the request body —
    // otherwise anyone could write into anyone else's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A url is required' }, 400)

    let parsed: URL
    try { parsed = new URL(url) } catch { return json({ ok: false, error: 'That is not a valid web address' }, 400) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Identify as a normal browser; some sites refuse anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!pageRes.ok) {
      return json({ ok: false, error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.` }, 422)
    }
    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({ ok: false, error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.` }, 415)
    }
    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process' }, 413)

    const { title, text } = htmlToText(raw)
    if (text.length < 200) {
      return json({ ok: false, error: 'Almost no readable text was found. The page probably builds itself with JavaScript after loading, which a server cannot see. Paste the text manually instead.' }, 422)
    }

    // Save: the thought holds the title, the address, and the start of the
    // article; thought_sources holds the whole thing.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const preview = text.length > CONTENT_PREVIEW ? text.slice(0, CONTENT_PREVIEW) + '\n\n[… full text saved]' : text
    const { data: thought, error: insErr } = await admin.from('thoughts').insert({
      user_id: user.id,
      content: `🔗 ${title}\n${parsed.toString()}\n\n${preview}`,
      metadata: { source: 'url', title, url: parsed.toString(), hostname: parsed.hostname, fetched_via: 'server' },
    }).select('id').single()
    if (insErr) throw insErr

    // Non-fatal on failure — the thought is already saved either way.
    const { error: srcErr } = await admin.from('thought_sources').insert({
      thought_id: thought.id, user_id: user.id, source_text: text,
      source_kind: 'web', char_count: text.length, truncated: false,
    })
    if (srcErr) console.warn('[url] thought_sources insert failed:', srcErr.message)

    return json({ ok: true, title, hostname: parsed.hostname, chars: text.length, preview: text.slice(0, 240) + '…' })
  } catch (err) {
    console.error('[url] Failed:', String(err))
    const msg = String(err).includes('timeout') ? 'That page took too long to respond.' : String(err)
    return json({ ok: false, error: msg }, 500)
  }
})

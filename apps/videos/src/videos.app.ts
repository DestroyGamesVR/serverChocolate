/**
 * RecFlare / serverChocolate videos media + catalog service (R2-free).
 *
 * NOTICE: This exposes a documented custom API for the revival, not a
 * reverse-engineered implementation of the 2026 Rec Room video protocol.
 * Wire up the game's exact request paths and JSON schemas after capturing
 * them; do not assume these custom paths match those of the game client.
 *
 * Safe by design: can only proxy HTTPS video origins from a fixed whitelist.
 * Logs never include query strings, credentials, or request bodies.
 */

type Bindings = {
  ENVIRONMENT?: string
  TEST_VIDEO_URL?: string
  VIDEOS_JSON?: string
}

type Video = { id: string; title: string; url: string }

const FALLBACK_VIDEO = 'https://zipline.ellinet13.com/u/4uZwaJ.mp4'
const ALLOWED_HOSTS = new Set(['zipline.ellinet13.com'])
const VIDEO_ID_RE = /^[a-z0-9_-]{1,64}$/i

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
  'X-Content-Type-Options': 'nosniff',
}

function approvedSource(raw: string): boolean {
  try {
    const source = new URL(raw)
    return source.protocol === 'https:' && ALLOWED_HOSTS.has(source.hostname) &&
      source.username === '' && source.password === '' && source.port === ''
  } catch {
    return false
  }
}

function videoCatalog(env: Bindings): Video[] {
  const raw: unknown = (() => {
    try { return JSON.parse(env.VIDEOS_JSON ?? '[]') }
    catch { return [] }
  })()

  const configured: Video[] = Array.isArray(raw) ? raw.flatMap((v: unknown) => {
    if (typeof v !== 'object' || !v || Array.isArray(v)) return []
    const item = v as Record<string, unknown>
    if (typeof item.id !== 'string' || !VIDEO_ID_RE.test(item.id) ||
        typeof item.title !== 'string' || typeof item.url !== 'string' ||
        !approvedSource(item.url)) return []
    return [{ id: item.id, title: item.title, url: item.url }]
  }) : []

  const testUrl = env.TEST_VIDEO_URL ?? FALLBACK_VIDEO
  if (!approvedSource(testUrl)) throw new Error('TEST_VIDEO_URL must be an approved HTTPS Zipline URL')
  const dedup = new Map<string, Video>([['test', { id: 'test', title: 'Test', url: testUrl }]])
  for (const video of configured) dedup.set(video.id, video)
  return [...dedup.values()]
}

function json(data: unknown, status = 200, method = 'GET'): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function videoPublic(video: Video, origin: string) {
  return {
    id: video.id,
    title: video.title,
    url: `${origin}/media/${encodeURIComponent(video.id)}.mp4`,
    sourceUrl: video.url,
    mimeType: 'video/mp4',
  }
}

async function proxyVideo(request: Request, video: Video): Promise<Response> {
  // No arbitrary URLs from the client. Only approved video records can be proxied.
  if (!approvedSource(video.url)) return json({ error: 'Unapproved video origin' }, 500, request.method)
  const requestHeaders = new Headers()
  const range = request.headers.get('Range')
  if (range) requestHeaders.set('Range', range)

  let upstream: Response
  try {
    upstream = await fetch(video.url, { method: request.method, headers: requestHeaders, redirect: 'manual' })
  } catch (error) {
    console.error('[videos] origin fetch failed', String(error))
    return json({ error: 'Video origin could not be reached' }, 502, request.method)
  }

  // Do not follow redirects to arbitrary domains. Zipline normally returns MP4 directly.
  if (upstream.status >= 300 && upstream.status < 400) {
    console.error('[videos] origin redirect blocked', upstream.status)
    return json({ error: 'Video origin redirected; not followed' }, 502, request.method)
  }

  const headers = new Headers(CORS_HEADERS)
  for (const key of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(key)
    if (value !== null) headers.set(key, value)
  }
  if (upstream.ok && !headers.has('Content-Type')) headers.set('Content-Type', 'video/mp4')
  console.log(`[videos] ${request.method} origin-status=${upstream.status} range=${range ? 'yes' : 'no'}`)
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers })
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()

    // Do not record IPs, tokens, URL query strings, authorization or cookies.
    console.log(`[videos] inbound ${method} ${path} content-type=${request.headers.get('Content-Type')?.split(';')[0] ?? 'none'}`)
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (method !== 'GET' && method !== 'HEAD') {
      return json({ error: 'Method not supported', method, path }, 405, method)
    }

    let videos: Video[]
    try { videos = videoCatalog(env) }
    catch (e) { return json({ error: String(e) }, 500, method) }
    const origin = url.origin

    if (path === '/health') {
      return json({ service: 'videos', status: 'ok', storage: 'external Zipline',
        gameApiStatus: '2026 client contract not yet identified' }, 200, method)
    }
    if (path === '/' || path === '/catalog' || path === '/videos') {
      return json({ videos: videos.map(v => videoPublic(v, origin)) }, 200, method)
    }

    const matchInfo = path.match(/^\/(?:catalog|videos)\/([a-z0-9_-]{1,64})$/i)
    if (matchInfo) {
      const video = videos.find(v => v.id === matchInfo[1])
      return video ? json(videoPublic(video, origin), 200, method) : json({ error: 'Video not found' }, 404, method)
    }
    const matchMedia = path.match(/^\/(?:media|stream)\/([a-z0-9_-]{1,64})(?:\.mp4)?$/i)
    if (matchMedia) {
      const video = videos.find(v => v.id === matchMedia[1])
      return video ? proxyVideo(request, video) : json({ error: 'Video not found' }, 404, method)
    }

    // Logging the unmatched method+path is the primary diagnostic for finding
    // the original client API. These are not fabricated compatibility routes.
    console.warn(`[videos] unknown client endpoint ${method} ${path}`)
    return json({ error: 'Unimplemented 2026 client endpoint', method, path,
      nextStep: 'Capture the client request route and required response schema.' }, 404, method)
  },
}

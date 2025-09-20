// server/index.js
import express from 'express'
import cors from 'cors'
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* =======================
   Basic server setup
   ======================= */
const app = express()
app.use(cors())

const PORT = process.env.PORT || 3000
const CACHE_MS = 5 * 60 * 1000 // 5 minutes
const ENABLE_ENRICH = process.env.ENRICH === '1' // opt-in enrichment via env

let cache = { time: 0, points: null }

/* =======================
   ESM-friendly __dirname
   ======================= */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* =======================
   Helper utilities
   ======================= */
function safeJSON(any) {
  try {
    if (typeof any === 'string') return JSON.parse(any)
    return any
  } catch { return null }
}

function flatten(obj, prefix = '', out = {}) {
  if (obj == null) return out
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}${prefix ? '.' : ''}${i}`, out))
    return out
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v, `${prefix}${prefix ? '.' : ''}${k}`, out)
    }
    return out
  }
  out[prefix] = obj
  return out
}

function toMs(tsLike) {
  if (tsLike == null) return NaN
  const n = Number(tsLike)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n // seconds vs ms
  const d = Date.parse(String(tsLike))
  return Number.isFinite(d) ? d : NaN
}

const KEY_CANDIDATES = {
  id:  ['id','balloon_id','balloonId','name','serial','imei','device','callsign'],
  time:['t','ts','timestamp','time','datetime','date','observed','recordedAt'],
  lat: ['lat','latitude','position.lat','pos.lat','coords.lat','location.lat'],
  lon: ['lon','lng','longitude','position.lon','pos.lon','coords.lon','location.lon'],
  alt: ['alt','altitude','elev','elevation','height'],
}

function findByKeys(flat, keys) {
  for (const k of keys) {
    if (flat[k] != null) return flat[k]
    const hit = Object.keys(flat).find(kk => kk.toLowerCase() === k.toLowerCase())
    if (hit && flat[hit] != null) return flat[hit]
  }
  return null
}

function latLonFromGeo(flat) {
  const g = flat['geometry.coordinates'] ?? flat['geom.coordinates'] ?? flat['coordinates']
  if (Array.isArray(g) && g.length >= 2 && Number.isFinite(+g[0]) && Number.isFinite(+g[1])) {
    return { lat: +g[1], lon: +g[0] } // GeoJSON is [lon, lat]
  }
  const cands = ['coord','coords','coordinate','coordinates','position','pos','location']
  for (const c of cands) {
    const v = flat[c]
    if (Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1])) {
      const a = +v[0], b = +v[1]
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b }
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a }
    }
    if (typeof v === 'string' && v.includes(',')) {
      const [a,b] = v.split(',').map(s => +s.trim())
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (Math.abs(a) <= 90) return { lat: a, lon: b }
        return { lat: b, lon: a }
      }
    }
  }
  return null
}

// Tuple form [lat, lon, maybeAlt] — synthesize id & time from file hour
function normalizeTuple(rec, hour, idx) {
  if (!Array.isArray(rec) || rec.length < 2) return null
  const lat = +rec[0], lon = +rec[1]
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const alt = Number.isFinite(+rec[2]) ? +rec[2] : null
  const ts = Date.now() - hour * 3600 * 1000
  return { id: `${hour.toString().padStart(2,'0')}-${idx}`, ts, iso: new Date(ts).toISOString(), lat, lon, alt }
}

function normalizeObject(rec) {
  if (!rec || typeof rec !== 'object') return null
  const flat = flatten(rec)

  let id = findByKeys(flat, KEY_CANDIDATES.id) ?? flat['__key']
  if (id == null) return null

  let timeRaw = findByKeys(flat, KEY_CANDIDATES.time)
  let ts = toMs(timeRaw)
  if (!Number.isFinite(ts)) {
    const guess = Object.keys(flat).find(k => /\b(time|timestamp|ts|datetime)\b/i.test(k))
    ts = toMs(flat[guess])
  }
  if (!Number.isFinite(ts)) return null

  let lat = +findByKeys(flat, KEY_CANDIDATES.lat)
  let lon = +findByKeys(flat, KEY_CANDIDATES.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const geo = latLonFromGeo(flat)
    if (geo) { lat = geo.lat; lon = geo.lon }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null

  let alt = +findByKeys(flat, KEY_CANDIDATES.alt)
  if (!Number.isFinite(alt)) alt = null

  return { id: String(id), ts, iso: new Date(ts).toISOString(), lat, lon, alt }
}

function explodeBodyToRecords(body) {
  const out = []
  const parsed = safeJSON(body) ?? body
  const push = r => { if (r != null) out.push(r) }

  if (Array.isArray(parsed)) {
    parsed.forEach(push)
  } else if (parsed && typeof parsed === 'object') {
    const arrKey = ['data','items','records','points','rows'].find(k => Array.isArray(parsed[k]))
    if (arrKey) parsed[arrKey].forEach(push)
    else {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) v.forEach(item => push({ __key: k, ...(safeJSON(item) ?? item) }))
        else if (v && typeof v === 'object') push({ __key: k, ...v })
      }
    }
  } else if (typeof body === 'string') {
    const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    if (lines.length > 1) lines.forEach(line => { const p = safeJSON(line); if (p) push(p) })
  }
  return out
}

function dedup(points) {
  const seen = new Set(), out = []
  for (const p of points) {
    const k = `${p.id}:${p.ts}`
    if (!seen.has(k)) { seen.add(k); out.push(p) }
  }
  return out.sort((a,b) => a.ts - b.ts)
}

/* =======================
   WindBorne fetch (last 24h)
   ======================= */
async function fetchWindborne24h(debug = false) {
  const hours = [...Array(24)].map((_, i) => i) // 0..23
  const urls = hours.map(h => `https://a.windbornesystems.com/treasure/${h.toString().padStart(2,'0')}.json`)

  const results = await Promise.allSettled(
    urls.map(u => axios.get(u, { timeout: 12_000, responseType: 'text' }).then(r => r.data))
  )

  let raw = 0, ok = 0, bad = 0
  const points = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status !== 'fulfilled') { bad++; continue }
    ok++

    const items = explodeBodyToRecords(r.value)
    raw += items.length

    if (items.length && Array.isArray(items[0])) {
      items.forEach((t, idx) => { const p = normalizeTuple(t, i, idx); if (p) points.push(p) })
    } else {
      items.forEach(o => { const p = normalizeObject(o); if (p) points.push(p) })
    }
  }

  const deduped = dedup(points)
  if (debug) {
    return {
      debug: { files_ok: ok, files_failed: bad, raw_records: raw, normalized: deduped.length, unique_points: deduped.length },
      points: deduped
    }
  }
  return deduped
}

/* =======================
   Optional enrichment
   ======================= */
async function enrich(points) {
  const BATCH = 25

  async function withWind(p) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m`
      const { data } = await axios.get(url, { timeout: 8000 })
      return { ...p, wind: data?.current ?? null }
    } catch { return { ...p, wind: null } }
  }

  async function withAir(p) {
    try {
      const url = `https://api.openaq.org/v2/latest?coordinates=${p.lat},${p.lon}&radius=20000&limit=1&parameter=pm25`
      const { data } = await axios.get(url, { timeout: 8000 })
      const m = data?.results?.[0]?.measurements?.find(x => x.parameter === 'pm25')
      return { ...p, air: m ? { pm25: m.value, unit: m.unit, lastUpdated: m.lastUpdated } : null }
    } catch { return { ...p, air: null } }
  }

  const out = []
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH)
    const enriched = await Promise.all(batch.map(async p => withAir(await withWind(p))))
    out.push(...enriched)
  }
  return out
}

/* =======================
   API routes
   ======================= */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    enrich_enabled: ENABLE_ENRICH,
    cached: Boolean(cache.points),
    cached_age_ms: cache.time ? Date.now() - cache.time : null
  })
})

app.get('/api/data', async (req, res) => {
  try {
    const now = Date.now()
    const wantDebug = String(req.query.debug ?? '') === '1'
    const noEnrich = String(req.query.noenrich ?? '') === '1'

    // serve from cache only if enrichment is enabled & requested
    if (!wantDebug && !noEnrich && ENABLE_ENRICH && cache.points && (now - cache.time < CACHE_MS)) {
      return res.json({ cached: true, points: cache.points })
    }

    const result = await fetchWindborne24h(wantDebug)
    const basePoints = wantDebug ? result.points : result

    let finalPoints = basePoints
    if (!noEnrich && ENABLE_ENRICH) finalPoints = await enrich(basePoints)

    if (!wantDebug && !noEnrich && ENABLE_ENRICH) cache = { time: now, points: finalPoints }

    if (wantDebug) {
      return res.json({
        cached: false,
        debug: result.debug,
        enriched: !noEnrich && ENABLE_ENRICH,
        points: finalPoints
      })
    }

    res.json({ cached: false, points: finalPoints })
  } catch (e) {
    res.status(500).json({ error: e?.message ?? 'unknown error' })
  }
})

/* =======================
   Static client (production)
   ======================= */
const distDir = path.resolve(__dirname, '..', 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  // Index for root
  app.get('/', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
  // SPA fallback (non-API routes)
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

/* =======================
   Start server
   ======================= */
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`)
})

/* =======================
   Optional: cache warm
   ======================= */
async function warm() {
  try {
    const basePoints = await fetchWindborne24h(false)
    cache = ENABLE_ENRICH
      ? { time: Date.now(), points: await enrich(basePoints) }
      : { time: Date.now(), points: basePoints }
  } catch { /* ignore */ }
}
warm()
setInterval(warm, CACHE_MS)

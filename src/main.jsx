import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// MarkerCluster plugin + styles
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import 'leaflet.markercluster'

// tiny dot icon for individual points
const dotCss = `
.dot {
  width: 6px; height: 6px;
  background: #1971c2;
  border: 1px solid #0b4f91;
  border-radius: 50%;
}
`

function App() {
  const mapRef = useRef(null)
  const clusterRef = useRef(null)
  const [hours, setHours] = useState(6)       // start less noisy than 24
  const [count, setCount] = useState(0)

  // init map once
  useEffect(() => {
    if (mapRef.current) return

    const map = L.map('map', { center: [20, 0], zoom: 2 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: 'Leaflet | © OpenStreetMap'
    }).addTo(map)

    // cluster layer
    const clusters = L.markerClusterGroup({
      chunkedLoading: true,
      removeOutsideVisibleBounds: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: false,
      disableClusteringAtZoom: 7,
      maxClusterRadius: z => Math.max(25, 140 - z * 15),
    })
    map.addLayer(clusters)

    mapRef.current = map
    clusterRef.current = clusters
  }, [])

  // fetch + draw
  async function load() {
    try {
      const url = `/api/data?noenrich=1&_=${Date.now()}`
      const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const { points } = await res.json()
      draw(points || [])
    } catch (err) {
      console.error('Error:', err)
    }
  }

  function draw(points) {
    if (!clusterRef.current) return
    clusterRef.current.clearLayers()

    const now = Date.now()
    const cutoff = now - hours * 3600 * 1000

    let shown = 0
    const markers = []

    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
      if (hours < 24 && Number.isFinite(p.ts) && p.ts < cutoff) continue

      const m = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: 'dot' }),
      })
      markers.push(m)
      shown++
    }

    // add in one go (plugin optimizes with chunkedLoading)
    if (markers.length) clusterRef.current.addLayers(markers)

    setCount(shown)
  }

  // initial + periodic refresh
  useEffect(() => {
    load()
    const id = setInterval(load, 5 * 60 * 1000) // every 5 min
    return () => clearInterval(id)
  }, [])

  // reload when slider changes
  useEffect(() => { load() }, [hours])

  return (
    <div id="app">
      <style>{dotCss}</style>

      <div className="panel">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>BalloonMap</div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Show last (hours):</span>
          <input
            type="range"
            min="1"
            max="24"
            step="1"
            value={hours}
            onChange={e => setHours(Number(e.target.value))}
          />
          <span>{hours === 24 ? 'All 24h' : `${hours}h`}</span>
        </label>

        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
          Auto-refreshes every 5 minutes. Data: WindBorne, Open-Meteo, OpenAQ.
          &nbsp;•&nbsp; Showing <b>{count}</b> points
        </div>
      </div>

      <div id="map" />

      <style>{`
        html, body, #root, #app, #map { height: 100%; width: 100%; margin: 0; }
        .panel {
          position: absolute;
          z-index: 1000;
          top: 12px; left: 12px;
          background: #fff;
          border-radius: 10px;
          padding: 10px 14px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        }
        input[type="range"] { width: 220px; }
      `}</style>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)

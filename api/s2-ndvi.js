import ee from '@google/earthengine';

// ─── Sentinel-2 NDVI map tiles (10 m) ───────────────────────────────────────
//
// GET /api/s2-ndvi?apikey=…&months=12 → { tile_url } for a clean, fine-grained
// NDVI overlay built from Copernicus Sentinel-2 SR — the same source the carbon
// calculation uses internally. Replaces the old MODIS MOD13Q1 overlay, which is
// 250 m and in a sinusoidal projection (it rendered as coarse, angled blocks at
// parcel zoom). Sentinel-2 is 10 m and reprojects cleanly to Web Mercator.
//
// getMapId returns a tile-URL template; Earth Engine computes each tile lazily
// on request, so a global median composite is fine here.

let SERVICE_ACCOUNT = null;
const API_KEY = process.env.API_KEY;
try {
  if (process.env.GEE_SERVICE_ACCOUNT) SERVICE_ACCOUNT = JSON.parse(process.env.GEE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('Error parsing GEE_SERVICE_ACCOUNT:', e.message);
}

// Standard red→green NDVI ramp (bare/low → dense vegetation).
const NDVI_PALETTE = [
  '#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b',
  '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837',
];

const initializeEarthEngine = () =>
  new Promise((resolve, reject) => {
    if (!SERVICE_ACCOUNT) return reject(new Error('GEE_SERVICE_ACCOUNT not configured'));
    ee.data.authenticateViaPrivateKey(SERVICE_ACCOUNT, () => {
      ee.initialize(null, null, resolve, reject);
    }, reject);
  });

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SERVICE_ACCOUNT) return res.status(500).json({ error: 'GEE_SERVICE_ACCOUNT not set' });
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not set' });
  if ((req.query?.apikey) !== API_KEY) return res.status(403).json({ error: 'Invalid API key' });

  const months = Math.min(36, Math.max(1, Number(req.query?.months) || 12));

  try {
    await initializeEarthEngine();

    // Recent, low-cloud Sentinel-2 SR → median NDVI (10 m).
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterDate(ee.Date(Date.now()).advance(-months, 'month'), ee.Date(Date.now()))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40));

    const ndvi = s2
      .map((img) => img.normalizedDifference(['B8', 'B4']).rename('ndvi'))
      .median();

    const visualized = ndvi.visualize({ min: 0.0, max: 0.8, palette: NDVI_PALETTE });

    const mapId = await new Promise((resolve, reject) => {
      ee.data.getMapId({ image: visualized }, (m, err) => (err ? reject(new Error(err)) : resolve(m)));
    });

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      tile_url: mapId.urlFormat,
      dataset: 's2-ndvi',
      description: 'Sentinel-2 SR median NDVI (10 m)',
      parameters: { months, min: 0.0, max: 0.8 },
    });
  } catch (e) {
    console.error('❌ s2-ndvi error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};

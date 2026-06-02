import ee from '@google/earthengine';

// ─── Real land-carbon zonal statistics over a user-drawn polygon ────────────
//
// POST { geometry: <GeoJSON Polygon>, apikey } → measured carbon densities
// sampled from published Earth Engine rasters and integrated over the polygon.
// No simulation, no random values: the same polygon always returns the same
// numbers (within EE's bestEffort pixel scaling).
//
// Pools & sources:
//   • Above-ground biomass — GEDI L4A footprints (NASA spaceborne lidar, 25 m
//     AGBD, Mg/ha) sampled inside the parcel when enough quality footprints
//     fall within it; otherwise ESA CCI Above-Ground Biomass v6.0 (100 m,
//     2022). Both are dry biomass → carbon via the IPCC 0.47 fraction. The
//     response reports which source was used and the GEDI footprint count.
//   • Below-ground biomass carbon — modeled from above-ground via an IPCC
//     root-to-shoot ratio (no fine global measured BGB product exists).
//   • Soil organic carbon — OpenLandMap SOC *content* (g/kg) × OpenLandMap
//     bulk density (kg/m³), trapezoid-integrated over 0–30 cm → t C/ha stock.
//   • Land cover make-up — ESA WorldCover v200 (10 m) class histogram.
//   • Vegetation health — Sentinel-2 SR median NDVI (last 12 months, low cloud).
//
// Carbon mass per pool = density (t C/ha) × area (ha). CO₂e = carbon × 44/12.

let SERVICE_ACCOUNT = null;
const API_KEY = process.env.API_KEY;
try {
  if (process.env.GEE_SERVICE_ACCOUNT) SERVICE_ACCOUNT = JSON.parse(process.env.GEE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('Error parsing GEE_SERVICE_ACCOUNT:', e.message);
}

const C_TO_CO2E = 44 / 12;        // molecular-weight ratio: 1 t C ⇄ 3.667 t CO₂e
const CARBON_FRACTION = 0.47;     // IPCC default: t carbon per t above-ground dry biomass
const ROOT_SHOOT_RATIO = 0.24;    // IPCC-range default: below-ground ÷ above-ground biomass
const MIN_GEDI_FOOTPRINTS = 5;    // need ≥ this many quality GEDI footprints in the parcel to prefer GEDI over ESA CCI

// ESA WorldCover class codes → human labels (v100/v200 share this scheme).
const WORLDCOVER_CLASSES = {
  10: 'Tree cover',
  20: 'Shrubland',
  30: 'Grassland',
  40: 'Cropland',
  50: 'Built-up',
  60: 'Bare / sparse vegetation',
  70: 'Snow & ice',
  80: 'Permanent water',
  90: 'Herbaceous wetland',
  95: 'Mangroves',
  100: 'Moss & lichen',
};

const initializeEarthEngine = () =>
  new Promise((resolve, reject) => {
    if (!SERVICE_ACCOUNT) return reject(new Error('GEE_SERVICE_ACCOUNT not configured'));
    ee.data.authenticateViaPrivateKey(SERVICE_ACCOUNT, () => {
      ee.initialize(null, null, resolve, reject);
    }, reject);
  });

// Promisified .evaluate() for any EE computed object.
const evaluate = (eeObject) =>
  new Promise((resolve, reject) => {
    eeObject.evaluate((value, err) => (err ? reject(new Error(err)) : resolve(value)));
  });

// Validate a GeoJSON polygon ring: array of [lng,lat] pairs within bounds.
function validatePolygon(geometry) {
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return false;
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return false; // ≥3 distinct + closing vertex
  for (const c of ring) {
    if (!Array.isArray(c) || c.length < 2) return false;
    const [lng, lat] = c;
    if (typeof lng !== 'number' || typeof lat !== 'number') return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  }
  return true;
}

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST with a GeoJSON polygon body.' });

  if (!SERVICE_ACCOUNT) return res.status(500).json({ error: 'GEE_SERVICE_ACCOUNT not set' });
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not set' });

  // Body may arrive parsed (Vercel) or as a raw string.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const apikey = body.apikey || req.query?.apikey;
  if (apikey !== API_KEY) return res.status(403).json({ error: 'Invalid API key' });

  const geometry = body.geometry;
  if (!validatePolygon(geometry)) {
    return res.status(400).json({ error: 'Invalid geometry — expected a GeoJSON Polygon with [lng,lat] coordinates in range.' });
  }

  try {
    await initializeEarthEngine();

    const geom = ee.Geometry.Polygon(geometry.coordinates);

    // ── Above-ground biomass, fallback layer — ESA CCI v6.0 (Mg/ha) ───────
    // 100 m, latest epoch (2022). `agb` is oven-dry woody biomass; `agb_sd` is
    // the product's per-pixel uncertainty (1σ). Used when GEDI is too sparse.
    const agbImg = ee.Image('ESA/CCI/Above_Ground_Biomass/V6_0/2022').select(['agb', 'agb_sd']);

    // ── Above-ground biomass, preferred layer — GEDI L4A footprints ───────
    // NASA spaceborne lidar, 25 m footprint AGBD (Mg/ha). Keep only quality
    // footprints (l4_quality_flag==1, degrade_flag==0). Sparse and limited to
    // ±51.6° latitude, so we measure how many land in the parcel and fall back
    // to ESA CCI below MIN_GEDI_FOOTPRINTS.
    const gediMasked = ee.ImageCollection('LARSE/GEDI/GEDI04_A_002_MONTHLY')
      .filterBounds(geom)
      .map((img) => {
        const ok = img.select('l4_quality_flag').eq(1).and(img.select('degrade_flag').eq(0));
        return img.select('agbd').updateMask(ok);
      })
      .mosaic();

    // ── Soil: OC content (g/kg, scale ×5) and bulk density (kg/m³, scale ×10)
    // at the 0/10/30 cm standard depths, renamed so we can read them in JS.
    const soc = ee.Image('OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02')
      .select(['b0', 'b10', 'b30'], ['soc0', 'soc10', 'soc30']);
    const bd = ee.Image('OpenLandMap/SOL/SOL_BULKDENS-FINEEARTH_USDA-4A1H_M/v02')
      .select(['b0', 'b10', 'b30'], ['bd0', 'bd10', 'bd30']);

    // ── Sentinel-2 median NDVI, last 12 months, <40% cloud ────────────────
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geom)
      .filterDate(ee.Date(Date.now()).advance(-12, 'month'), ee.Date(Date.now()))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40));
    const ndvi = s2.map((img) => img.normalizedDifference(['B8', 'B4']).rename('ndvi')).median();

    // One reduceRegion for every continuous band (mean), bestEffort so big
    // polygons coarsen the scale instead of failing on maxPixels.
    const meanImage = agbImg.addBands(soc).addBands(bd).addBands(ndvi);

    const meansP = evaluate(meanImage.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: geom,
      scale: 100,
      bestEffort: true,
      maxPixels: 1e9,
    }));

    // NDVI spatial variability (consistency indicator).
    const ndviStdP = evaluate(ndvi.reduceRegion({
      reducer: ee.Reducer.stdDev(), geometry: geom, scale: 100, bestEffort: true, maxPixels: 1e9,
    }));

    // WorldCover class histogram (pixel counts per land-cover code).
    const worldcover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
    const histP = evaluate(worldcover.reduceRegion({
      reducer: ee.Reducer.frequencyHistogram(), geometry: geom, scale: 10, bestEffort: true, maxPixels: 1e9,
    }));

    // GEDI footprint stats inside the parcel: mean/stdDev AGBD + valid count.
    const gediStatsP = evaluate(gediMasked.reduceRegion({
      reducer: ee.Reducer.mean().combine(ee.Reducer.stdDev(), '', true).combine(ee.Reducer.count(), '', true),
      geometry: geom, scale: 25, bestEffort: true, maxPixels: 1e9,
    }));

    // True geodesic area (m² → ha). 1 m tolerance.
    const areaP = evaluate(geom.area(1));
    const s2CountP = evaluate(s2.size());

    const [means, ndviStd, hist, areaM2, s2Count, gediStats] = await Promise.all([meansP, ndviStdP, histP, areaP, s2CountP, gediStatsP]);

    const areaHectares = areaM2 / 10000;

    // ── Biomass carbon ────────────────────────────────────────────────────
    // Prefer GEDI L4A footprints when enough quality footprints fell inside the
    // parcel; otherwise use the ESA CCI wall-to-wall product. Both give
    // above-ground *biomass* (dry matter, Mg/ha) → carbon via the IPCC carbon
    // fraction. Below-ground carbon is modeled via an IPCC root-to-shoot ratio.
    // All densities in t C/ha.
    const gediCount = gediStats.agbd_count ?? 0;
    const gediMean = gediStats.agbd_mean;
    const useGedi = gediCount >= MIN_GEDI_FOOTPRINTS && gediMean != null;

    const cciBiomass = means.agb ?? 0;                      // Mg/ha
    const cciBiomassSd = means.agb_sd ?? 0;                 // Mg/ha (1σ)

    const agbBiomass = useGedi ? gediMean : cciBiomass;     // Mg dry biomass/ha
    // 1σ density (Mg/ha): GEDI → spatial stdDev across footprints; ESA CCI →
    // the product's own per-pixel SD.
    const agbBiomassSd = useGedi ? (gediStats.agbd_stdDev ?? 0) : cciBiomassSd;
    const agbSource = useGedi ? 'GEDI L4A (lidar footprints)' : 'ESA CCI Biomass v6.0';

    const agbDensity = agbBiomass * CARBON_FRACTION;        // t C/ha
    const bgbDensity = agbDensity * ROOT_SHOOT_RATIO;       // t C/ha (modeled)
    const agbUncDensity = agbBiomassSd * CARBON_FRACTION;   // t C/ha (1σ)
    const bgbUncDensity = agbUncDensity * ROOT_SHOOT_RATIO;

    // ── Soil organic carbon stock, 0–30 cm (t C/ha) ───────────────────────
    // content[g C/kg] × bulkDensity[kg/m³] = g C/m³; integrate over depth (m)
    // by trapezoid → g C/m²; ×0.01 → t C/ha. Apply OpenLandMap scale factors:
    // SOC content ×5, bulk density ×10.
    const cMass = (rawSoc, rawBd) => (rawSoc ?? 0) * 5 * (rawBd ?? 0) * 10; // g C/m³
    const f0 = cMass(means.soc0, means.bd0);
    const f10 = cMass(means.soc10, means.bd10);
    const f30 = cMass(means.soc30, means.bd30);
    // trapezoid 0→0.1 m and 0.1→0.3 m, result g C/m² → ×0.01 → t C/ha
    const soilDensity = (((f0 + f10) / 2) * 0.1 + ((f10 + f30) / 2) * 0.2) * 0.01;

    // ── Per-pool totals (tonnes carbon) and CO₂e ──────────────────────────
    const agbC = agbDensity * areaHectares;
    const bgbC = bgbDensity * areaHectares;
    const soilC = soilDensity * areaHectares;
    const totalC = agbC + bgbC + soilC;

    // Biomass uncertainty (t CO₂e), propagated in quadrature; soil reported
    // without a formal band so excluded from the ± envelope.
    const agbUncC = agbUncDensity * areaHectares;
    const bgbUncC = bgbUncDensity * areaHectares;
    const biomassUncC = Math.sqrt(agbUncC * agbUncC + bgbUncC * bgbUncC);

    // ── Land cover percentages from the histogram ─────────────────────────
    const rawHist = hist.Map || {};
    const totalPixels = Object.values(rawHist).reduce((s, v) => s + v, 0) || 1;
    const landCover = Object.entries(rawHist)
      .map(([code, count]) => ({
        code: Number(code),
        label: WORLDCOVER_CLASSES[Number(code)] || `Class ${code}`,
        percent: Number(((count / totalPixels) * 100).toFixed(1)),
      }))
      .filter((c) => c.percent > 0)
      .sort((a, b) => b.percent - a.percent);

    const round = (n, d = 2) => Number((n || 0).toFixed(d));

    return res.status(200).json({
      success: true,
      area: { hectares: round(areaHectares, 4), acres: round(areaHectares * 2.47105, 4) },
      // Carbon stock in tonnes of carbon (t C).
      carbon_tonnes: {
        total: round(totalC),
        above_ground_biomass: round(agbC),
        below_ground_biomass: round(bgbC),
        soil_organic: round(soilC),
      },
      // Same stock expressed as CO₂-equivalent (t CO₂e = t C × 44/12).
      co2e_tonnes: {
        total: round(totalC * C_TO_CO2E),
        above_ground_biomass: round(agbC * C_TO_CO2E),
        below_ground_biomass: round(bgbC * C_TO_CO2E),
        soil_organic: round(soilC * C_TO_CO2E),
      },
      // Per-hectare densities (t C/ha) for transparency.
      density_t_c_per_ha: {
        above_ground_biomass: round(agbDensity),
        below_ground_biomass: round(bgbDensity),
        soil_organic: round(soilDensity),
      },
      // Biomass-carbon uncertainty envelope as CO₂e (± around biomass total).
      uncertainty_co2e: {
        biomass_plus_minus: round(biomassUncC * C_TO_CO2E),
      },
      biomass_source: {
        above_ground: agbSource,
        used_gedi: useGedi,
        gedi_footprints: gediCount,
      },
      vegetation: {
        ndvi_mean: means.ndvi != null ? round(means.ndvi, 3) : null,
        ndvi_std: ndviStd.ndvi != null ? round(ndviStd.ndvi, 3) : null,
        sentinel2_scenes: s2Count,
      },
      land_cover: landCover,
      sources: {
        biomass: 'Above-ground from GEDI L4A lidar footprints (25 m AGBD) when ≥5 land in the parcel, else ESA CCI Biomass v6.0 (100 m, 2022); dry biomass → carbon ×0.47 IPCC; below-ground modeled ×0.24 root-to-shoot',
        soil: 'OpenLandMap Soil Organic Carbon Content × Bulk Density (USDA), 250 m, integrated 0–30 cm',
        land_cover: 'ESA WorldCover v200, 10 m',
        vegetation: 'Copernicus Sentinel-2 SR (median NDVI, last 12 months, <40% cloud)',
      },
      method: 'Earth Engine zonal statistics over user polygon — measured carbon-density rasters, no simulation.',
    });
  } catch (e) {
    console.error('❌ carbon endpoint error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};

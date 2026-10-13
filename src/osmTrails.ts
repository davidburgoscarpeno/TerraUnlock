// v1.123: etiquetas de caminos de OpenStreetMap cerca de una cima (Overpass, gratis, sin clave).
// Solo cuenta etiquetas literales de los tramos a menos de RADIUS m; NO identifica una ruta hasta la cumbre.
export type PeakTrails = { ways: number; radius: number; sac: { v: string; n: number }[]; sacMissing: number; surface: { v: string; n: number }[] };
const RADIUS = 500;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const cache = new Map<string, PeakTrails>();

function tally(vals: string[]): { v: string; n: number }[] {
    const m = new Map<string, number>();
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
}

export async function fetchPeakTrails(lat: number, lon: number): Promise<PeakTrails> {
    const key = lat.toFixed(4) + ',' + lon.toFixed(4);
    const hit = cache.get(key);
    if (hit) return hit;
    const q = '[out:json][timeout:20];way(around:' + RADIUS + ',' + lat + ',' + lon + ')["highway"~"^(path|footway|track|steps|bridleway|via_ferrata)$"];out tags;';
    let lastErr: unknown = null;
    for (const ep of ENDPOINTS) {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 22000);
        try {
            const res = await fetch(ep + '?data=' + encodeURIComponent(q), { signal: ac.signal });
            clearTimeout(tm);
            if (!res.ok) { lastErr = new Error('overpass ' + res.status); continue; }
            const data = await res.json();
            const els: { tags?: Record<string, string> }[] = Array.isArray(data && data.elements) ? data.elements : [];
            const sacVals = els.map((e) => (e.tags && e.tags.sac_scale) || '').filter(Boolean);
            const out: PeakTrails = {
                ways: els.length, radius: RADIUS,
                sac: tally(sacVals), sacMissing: els.length - sacVals.length,
                surface: tally(els.map((e) => (e.tags && e.tags.surface) || '').filter(Boolean)).slice(0, 6)
            };
            cache.set(key, out);
            return out;
        } catch (e) { clearTimeout(tm); lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error('overpass');
}

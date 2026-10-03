// v1.39: integracion Strava. El intercambio de tokens pasa por un Cloudflare Worker
// (el secret nunca toca el repo ni el cliente). Tokens y estado en localStorage.
const WORKER = 'https://terraunlock-strava.dburgoscarpeno.workers.dev';
const LS_CONN = 'tu_strava';
const LS_STATE = 'tu_strava_state';

export type StravaConn = {
    access_token: string;
    refresh_token: string;
    expires_at: number; // unix seconds
    athlete: { id: number; firstname: string; profile?: string } | null;
    importedIds: number[];
    lastSync?: string;
};

export function loadStrava(): StravaConn | null {
    try {
        const raw = localStorage.getItem(LS_CONN);
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (!c || typeof c.access_token !== 'string') return null;
        if (!Array.isArray(c.importedIds)) c.importedIds = [];
        return c as StravaConn;
    } catch { return null; }
}
export function saveStrava(c: StravaConn | null) {
    try {
        if (c) localStorage.setItem(LS_CONN, JSON.stringify(c));
        else localStorage.removeItem(LS_CONN);
    } catch { /* sin espacio */ }
}

// Paso 1: redirigir a Strava para autorizar
export async function beginStravaConnect(): Promise<void> {
    const res = await fetch(WORKER + '/config');
    if (!res.ok) throw new Error('config ' + res.status);
    const { client_id } = await res.json();
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(LS_STATE, state); } catch { /* ok */ }
    const redirect = window.location.origin + window.location.pathname;
    const url = 'https://www.strava.com/oauth/authorize?client_id=' + encodeURIComponent(client_id)
        + '&response_type=code&redirect_uri=' + encodeURIComponent(redirect)
        + '&approval_prompt=auto&scope=activity:read_all&state=' + encodeURIComponent(state);
    window.location.assign(url);
}

// Paso 2: al volver con ?code&state en la URL. Devuelve el nombre del atleta o null si no hay callback.
export async function completeStravaConnect(): Promise<string | null> {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code'), state = q.get('state');
    if (!code || !state) return null;
    const expected = (() => { try { return localStorage.getItem(LS_STATE); } catch { return null; } })();
    const clean = () => { try { window.history.replaceState({}, '', window.location.pathname); localStorage.removeItem(LS_STATE); } catch { /* ok */ } };
    if (!expected || expected !== state) { clean(); throw new Error('state'); }
    const res = await fetch(WORKER + '/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    const data = await res.json();
    clean();
    if (!res.ok || !data.access_token) throw new Error('exchange ' + res.status);
    saveStrava({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete: data.athlete || null,
        importedIds: []
    });
    return data.athlete && data.athlete.firstname ? String(data.athlete.firstname) : '';
}

// Token vigente (renueva via worker si caduca en <60s)
export async function ensureStravaToken(): Promise<StravaConn> {
    const c = loadStrava();
    if (!c) throw new Error('no conectado');
    if (c.expires_at - 60 > Date.now() / 1000) return c;
    const res = await fetch(WORKER + '/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: c.refresh_token })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) { saveStrava(null); throw new Error('refresh ' + res.status); }
    const next: StravaConn = { ...c, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at };
    saveStrava(next);
    return next;
}

export type StravaTrack = { name: string; pts: [number, number][]; times: (string | null)[]; stravaId?: number; sport?: string };

// v1.41: sport_type de Strava -> tipo interno ('' = desconocido, se inferira del ritmo)
function mapStravaSport(st: string): string {
    const s = (st || '').toLowerCase();
    if (s.includes('run') || s.includes('jog')) return 'run';
    if (s.includes('ride') || s.includes('bike') || s.includes('cycle') || s.includes('velo') || s.includes('gravel')) return 'ride';
    if (s.includes('hike') || s.includes('mountaineer') || s.includes('climb')) return 'hike';
    if (s.includes('walk')) return 'walk';
    return '';
}

export type StravaProg = { phase: 'list' | 'streams'; page?: number; listed?: number; done: number; total: number; got: number; noGps: number; etaSec?: number };
export type StravaRun = { tracks: StravaTrack[]; rateLimited: boolean; noGps: number; cancelled: boolean; pending: number; error?: string };

// v1.121: fetch con timeout (20 s) y un reintento ante red caida; 429 se devuelve tal cual
async function stravaGet(url: string, token: string, ctl: { cancelled: boolean }): Promise<Response> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (ctl.cancelled) throw new Error('cancelado');
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 20000);
        try {
            const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
            clearTimeout(tm);
            return res;
        } catch (e) {
            clearTimeout(tm);
            last = e;
            await new Promise((r) => setTimeout(r, 1200));
        }
    }
    throw new Error(last instanceof Error && last.name === 'AbortError' ? 'Strava no responde (tiempo agotado)' : 'sin conexion con Strava');
}

// Descarga actividades con GPS y las convierte en tracks (hasta 400; Strava limita a ~100 peticiones cada 15 min, se puede reanudar)
export async function fetchStravaTracks(onProgress?: (p: StravaProg) => void, ctl: { cancelled: boolean } = { cancelled: false }): Promise<StravaRun> {
    const conn = await ensureStravaToken();
    const done = new Set(conn.importedIds);
    // 1) lista de actividades (hasta 8 paginas x 50)
    const acts: { id: number; name: string; start_date: string; sport: string }[] = [];
    let listLimited = false;
    for (let page = 1; page <= 8; page++) {
        onProgress?.({ phase: 'list', page, listed: acts.length, done: 0, total: 0, got: 0, noGps: 0 });
        const res = await stravaGet('https://www.strava.com/api/v3/athlete/activities?per_page=50&page=' + page, conn.access_token, ctl);
        if (res.status === 429) { listLimited = true; break; }
        if (res.status === 401) throw new Error('Strava rechazo el acceso (401): desconecta y vuelve a conectar');
        if (!res.ok) throw new Error('activities ' + res.status);
        const arr = await res.json();
        if (!Array.isArray(arr) || !arr.length) break;
        for (const a of arr) acts.push({ id: a.id, name: a.name || 'Actividad Strava', start_date: a.start_date, sport: mapStravaSport(a.sport_type || a.type || '') });
        if (arr.length < 50) break;
    }
    const pending = acts.filter((a) => !done.has(a.id));
    if (listLimited && !acts.length) return { tracks: [], rateLimited: true, noGps: 0, cancelled: false, pending: 0 };
    // 2) streams de cada una
    const tracks: StravaTrack[] = [];
    let noGps = 0;
    const newlyDone: number[] = [];
    const t0run = Date.now();
    let rateLimited = listLimited;
    let cancelled = false;
    let processed = 0;
    for (let i = 0; i < pending.length; i++) {
        if (ctl.cancelled) { cancelled = true; break; }
        const a = pending[i];
        const el = (Date.now() - t0run) / 1000;
        onProgress?.({ phase: 'streams', done: i, total: pending.length, got: tracks.length, noGps, etaSec: i >= 2 ? Math.round((el / i) * (pending.length - i)) : undefined });
        let res: Response;
        try { res = await stravaGet('https://www.strava.com/api/v3/activities/' + a.id + '/streams?keys=latlng,time&key_by_type=true', conn.access_token, ctl); }
        catch (e) {
            if (ctl.cancelled) { cancelled = true; break; }
            // red caida a mitad: devolver lo ya descargado con el error
            const c3 = loadStrava(); if (c3) { c3.importedIds = [...c3.importedIds, ...newlyDone]; saveStrava(c3); }
            return { tracks, rateLimited: false, noGps, cancelled: false, pending: pending.length - i, error: e instanceof Error ? e.message : 'error de red' };
        }
        if (res.status === 429) { rateLimited = true; break; }
        processed = i + 1;
        if (!res.ok) { newlyDone.push(a.id); continue; } // actividad con error: la saltamos para siempre
        const s = await res.json();
        const latlng = s && s.latlng && Array.isArray(s.latlng.data) ? s.latlng.data as [number, number][] : null;
        if (!latlng || latlng.length < 2) { noGps++; newlyDone.push(a.id); continue; }
        const t0 = new Date(a.start_date).getTime();
        const times: (string | null)[] = Array.isArray(s.time && s.time.data)
            ? (s.time.data as number[]).map((sec) => new Date(t0 + sec * 1000).toISOString())
            : latlng.map(() => null);
        tracks.push({ name: a.name, pts: latlng, times, stravaId: a.id, sport: a.sport || undefined });
        if (i < pending.length - 1) await new Promise((r) => setTimeout(r, 150)); // suavizar el rate limit
    }
    // marcar las procesadas sin exito (sin GPS o error) para no volver a pedirlas; las correctas se marcan al aplicar el lote
    const c2 = loadStrava();
    if (c2) { c2.importedIds = [...c2.importedIds, ...newlyDone]; saveStrava(c2); }
    return { tracks, rateLimited, noGps, cancelled, pending: Math.max(0, pending.length - processed) };
}

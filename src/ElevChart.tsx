// v1.11: grafico del perfil de elevacion de una aventura (datos: AWS Terrain Tiles / Terrarium).
import { useEffect, useRef, useState } from 'react';
import { computeProfile, drawProfile } from './adventureProfile';
import type { Adventure, AdventureProfile } from './types';

export default function ElevChart({ adv, onProfile }: { adv: Adventure; onProfile: (start: string, prof: AdventureProfile | null) => void }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'none'>(adv.profile ? 'ready' : 'loading');
    useEffect(() => {
        let dead = false;
        if (adv.profile) { setState('ready'); return; }
        if (!adv.track || adv.track.length < 2 || adv.noProfile) { setState('none'); return; }
        setState('loading');
        computeProfile(adv.track)
            .then((prof) => { if (!dead) { onProfile(adv.start, prof); setState('ready'); } })
            .catch(() => { if (!dead) { onProfile(adv.start, null); setState('none'); } });
        return () => { dead = true; };
    }, [adv, onProfile]);
    useEffect(() => {
        const cv = ref.current;
        if (state !== 'ready' || !adv.profile || !cv) return;
        const g = cv.getContext('2d');
        if (g) drawProfile(g, 0, 0, cv.width, cv.height, adv.profile);
    }, [state, adv]);
    if (state === 'none') return <div className="tu-terrnote">Perfil de elevacion no disponible para esta aventura.</div>;
    return <div className="tu-elev">
        {state === 'loading' ? <div className="tu-terrnote">Calculando perfil de elevacion...</div> : null}
        <canvas ref={ref} width={640} height={240} style={{ display: state === 'ready' ? 'block' : 'none' }} />
        {state === 'ready' && adv.profile ? <div className="tu-terrnote">Subida acumulada +{adv.profile.up} m - Bajada -{adv.profile.down} m - Cotas {adv.profile.min}-{adv.profile.max} m</div> : null}
    </div>;
}

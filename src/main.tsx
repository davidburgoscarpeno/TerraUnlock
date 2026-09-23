import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);

// PWA: service worker solo en produccion
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then((reg) => {
            // v1.34: avisar a la app cuando hay una version nueva instalada
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        window.dispatchEvent(new CustomEvent('tu-sw-update'));
                    }
                });
            });
            // con la app abierta mucho tiempo, buscar novedades cada hora
            window.setInterval(() => { reg.update().catch(() => { /* offline */ }); }, 60 * 60 * 1000);
        }).catch(() => { /* sin SW: la app funciona igual */ });
    });
}

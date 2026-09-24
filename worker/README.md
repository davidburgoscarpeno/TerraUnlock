# terraunlock-strava worker

Proxy OAuth de Strava desplegado en terraunlock-strava.dburgoscarpeno.workers.dev.

Este worker.js es el bundle desplegado tal como lo devuelve la API de Cloudflare
(recuperado el 24-sep-2026 tras perderse la copia local). Si se edita, desplegar
con wrangler desde aqui para que el repo siga siendo la fuente de verdad.

Secretos (en Cloudflare, no aqui): STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET.

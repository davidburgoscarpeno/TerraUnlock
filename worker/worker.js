var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var ALLOWED_ORIGIN = "https://davidburgoscarpeno.github.io";
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}
__name(jsonResponse, "jsonResponse");
var worker_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: "forbidden_origin" }, 403, origin);
    }
    if (url.pathname === "/config" && request.method === "GET") {
      return jsonResponse({ client_id: env.STRAVA_CLIENT_ID }, 200, origin);
    }
    if (url.pathname === "/exchange" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "bad_json" }, 400, origin);
      }
      if (!body || typeof body.code !== "string" || body.code.length === 0) {
        return jsonResponse({ error: "missing_code" }, 400, origin);
      }
      return stravaToken("authorization_code", { code: body.code }, env, origin);
    }
    if (url.pathname === "/refresh" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "bad_json" }, 400, origin);
      }
      if (!body || typeof body.refresh_token !== "string" || body.refresh_token.length === 0) {
        return jsonResponse({ error: "missing_refresh_token" }, 400, origin);
      }
      return stravaToken("refresh_token", { refresh_token: body.refresh_token }, env, origin);
    }
    return jsonResponse({ error: "not_found" }, 404, origin);
  }
};
async function stravaToken(grantType, extra, env, origin) {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: grantType,
    ...extra
  });
  try {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: "strava_error", detail: data }, res.status, origin);
    }
    return jsonResponse({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete: data.athlete ? { id: data.athlete.id, firstname: data.athlete.firstname } : null
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "worker_error", detail: String(e) }, 500, origin);
  }
}
__name(stravaToken, "stravaToken");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map


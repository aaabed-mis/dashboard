/* Supabase project config — publishable key, safe for browser use.
   Hosted project: https://lkvmsahrcvcxvfrxilhk.supabase.co (shared suite auth). */
const SUPABASE_URL = "https://lkvmsahrcvcxvfrxilhk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2GVGD9zl3v5ezD1eiRFOjA_uhPDE5NI";

/* The hub owns the only login form. Dashboards send users back here. */
const HUB_URL = "/";   // hub is served at the root of this same origin

/* Ports used only in the offline cross-origin harness (see below). */
const HARNESS_PORTS = { hub: 8090, aging: 8091, inventory: 8092, purchasing: 8093 };

function isLocalDev() {
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

/* Sessions live in localStorage, which is per-ORIGIN. Production is ONE origin
   (dashboard.abederp.com): the hub at "/", this dashboard at "/<id>/", so the
   session is already visible here — no handoff needed. The cross-origin path
   exists only for the offline four-port harness: add ?crossorigin=1 to the hub
   URL; otherwise local use stays on one origin and needs no handoff at all. */
function crossOriginHarness() {
  try {
    return new URLSearchParams(location.search).get('crossorigin') === '1';
  } catch (e) { return false; }
}

/* Absolute origin for a dashboard, or null to use the relative sibling path. */
function resolveSiteOrigin(id) {
  if (!isLocalDev()) return null;              // production: same-origin sibling path
  if (!crossOriginHarness()) return null;      // one local server: same origin
  const port = HARNESS_PORTS[id];
  return port ? 'http://' + location.hostname + ':' + port + '/' : null;
}

/* Where the "go to the hub" links point. The hub passes its own location in the
   hand-off fragment, so a dashboard always knows where to send the user back —
   even in the four-port harness where a relative path would resolve to the wrong
   port. */
function resolveHubUrl() {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    const hub = h.get('hub');
    if (hub) return hub;
  } catch (e) { /* ignore */ }
  if (location.protocol === 'file:') {
    return new URL('../index.html', location.href).href;
  }
  if (!isLocalDev()) return HUB_URL;           // production
  if (crossOriginHarness()) {
    return 'http://' + location.hostname + ':' + HARNESS_PORTS.hub + '/';
  }
  return new URL('../', location.href).href;   // one local server: hub is the parent folder
}

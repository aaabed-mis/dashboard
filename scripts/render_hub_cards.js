// Render the hub cards for a given allowlist using the REAL app.js + data/hub.js.
// Usage: node scripts/render_hub_cards.js [comma,separated,allowlist]
// Default allowlist = c.crizaldo's current grants.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const allowlist = (process.argv[2] || 'inventory,material-aging,purchasing,material-aging-aaa,ap')
  .split(',').map(s => s.trim()).filter(Boolean);

// ---- minimal DOM stub -----------------------------------------------------
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    classList: { remove() {}, add() {} },
    setAttribute() {},
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}
const grid = makeEl('grid');
const menu = makeEl('user-menu');
const rootEl = { setAttribute() {} };
const listeners = {};

const sandbox = {
  console,
  window: {},
  document: {
    documentElement: rootEl,
    getElementById: id => ({ grid, 'user-menu': menu, 'theme-toggle': null, 'built-line': null }[id] || null),
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    querySelectorAll: () => [],
  },
  location: { protocol: 'http:', href: 'http://localhost/', origin: 'http://localhost', search: '' },
  localStorage: { getItem: () => null, setItem() {} },
  URLSearchParams,
  URL,
  Set,
  CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

// load data/hub.js (sets window.__HUB__) then app.js
const hubSrc = fs.readFileSync(path.join(ROOT, 'data', 'hub.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
vm.runInContext(hubSrc, sandbox);
vm.runInContext(appSrc, sandbox);

// dispatch auth:ready with the allowlist
const ev = new sandbox.CustomEvent('auth:ready', { detail: { dashboards: allowlist } });
listeners['auth:ready'](ev);

// ---- report --------------------------------------------------------------
const html = grid.innerHTML;
const titles = [...html.matchAll(/<h3 class="card-title">([^<]+)<\/h3>/g)].map(m => m[1]);
const ids = [...html.matchAll(/data-dashboard="([^"]+)"/g)].map(m => m[1]);
const empty = html.includes('No dashboards assigned');

console.log('Allowlist:', allowlist.join(', '));
console.log('Rendered card ids:', ids.length ? ids.join(', ') : '(none)');
console.log('Rendered card titles:');
titles.forEach(t => console.log('  - ' + t));
if (empty) console.log('  [grid-empty: No dashboards assigned]');

const ap = ids.includes('ap');
console.log('\nAP card present:', ap ? 'YES' : 'NO');
if (ap) {
  const apCard = html.match(/<article class="card" style="--card-accent:([^;]+);--card-ink:([^"]+)">[\s\S]*?<h3 class="card-title">([^<]+)<\/h3>[\s\S]*?<p class="card-byline">([^<]+)<\/p>[\s\S]*?<p class="card-desc">([^<]+)<\/p>/);
  if (apCard) {
    console.log('  accent:', apCard[1], '| ink:', apCard[2]);
    console.log('  title:', apCard[3]);
    console.log('  byline:', apCard[4]);
    console.log('  desc:', apCard[5]);
  }
  const route = sandbox.window.__hubRoute ? sandbox.window.__hubRoute('ap') : '(no __hubRoute)';
  console.log('  route (targetFor):', route);
}
process.exit(ap ? 0 : 1);

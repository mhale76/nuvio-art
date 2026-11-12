// Nuvio "series fix" add-on.
// For shows that the databases number differently from the releases, Nuvio asks
// for the wrong series or episode. This add-on rewrites the request and asks
// AIOStreams for the numbering the releases use.
//
// Two kinds of fix:
//  - offset: shift every series number (e.g. Bake Off: Channel 4 series 1 = UK series 8)
//  - episodes: per-episode list of candidate numbers to try, in order (e.g. Christmas
//    specials that the databases file under "Season 0"). All candidates are asked in
//    parallel and the first one (in list order) that returns streams wins. Episodes
//    not listed return nothing, so Nuvio's normal AIOStreams results are not doubled.
//
// Settings (environment variables):
// AIOSTREAMS_URL your AIOStreams install link (ends in /manifest.json). Required.
// PORT port to listen on (default 7020)
// EXTRA_MAP optional JSON to add shows, e.g.
// {"tt1234567":{"to":"tt7654321","offset":3}}
// {"tt1234567":{"episodes":{"0:2":["3:7","0:2"]}}}

const http = require('http');

const MAP = Object.assign({
  // The Great British Bake Off, Channel 4 years (2017 on). Its series 1 is UK series 8.
  tt21958588: { to: 'tt1877368', offset: 7 },
  // Gavin & Stacey: Christmas specials are Season 0 in TVDB/Trakt (S0E1 2008, S0E15 2019,
  // S0E19 2024 finale). Releases may number them as extra series episodes instead.
  tt0908454: {
    episodes: {
      '0:1': ['2:8', '0:1', '3:0', '2:0'],
      '0:15': ['3:7', '0:2', '0:15', '4:1'],
      '0:19': ['3:8', '0:3', '0:19', '4:1', '4:2'],
    },
    // Episode list clean-up: keep only these specials (Season 0), with these names.
    keepSpecials: { 1: '2008 Christmas Special', 15: '2019 Christmas Special', 19: 'The Finale (2024)' },
  },
}, JSON.parse(process.env.EXTRA_MAP || '{}'));

const AIO = (process.env.AIOSTREAMS_URL || '').replace(/\/manifest\.json.*$/, '').replace(/\/+$/, '');
// Optional: your Xperience install link, so Series Fix can serve a tidied episode list
// (shows with keepSpecials). Without it, the episode list is left to Xperience.
const XP = (process.env.XPERIENCE_URL || '').replace(/\/manifest\.json.*$/, '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 7020);

const META_SHOWS = Object.keys(MAP).filter((k) => MAP[k].keepSpecials);
const resources = [{ name: 'stream', types: ['series'], idPrefixes: Object.keys(MAP) }];
if (XP && META_SHOWS.length) resources.push({ name: 'meta', types: ['series'], idPrefixes: META_SHOWS });

const manifest = {
  id: 'uk.markhale.seriesfix',
  version: '1.3.0',
  name: 'Series Fix',
  description: 'Fixes series and special-episode numbering (e.g. Bake Off, Gavin & Stacey specials), tidies specials lists, and fetches streams from AIOStreams.',
  types: ['series'],
  catalogs: [],
  resources,
  idPrefixes: Object.keys(MAP),
};

// Episode list from Xperience, with Season 0 cut down to the specials worth keeping.
async function metaFor(id) {
  const imdb = decodeURIComponent(id).split(':')[0];
  const keep = MAP[imdb] && MAP[imdb].keepSpecials;
  if (!keep || !XP) return { meta: null };
  try {
    const r = await fetch(`${XP}/meta/series/${imdb}.json`);
    if (!r.ok) return { meta: null };
    const data = await r.json();
    const m = data.meta || {};
    m.videos = (m.videos || [])
      .filter((v) => v.season !== 0 || keep[v.episode])
      .map((v) => (v.season === 0 ? { ...v, title: keep[v.episode], name: keep[v.episode] } : v));
    return { meta: m };
  } catch (err) {
    console.error('meta error', imdb, err.message);
    return { meta: null };
  }
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'max-age=300',
  });
  res.end(JSON.stringify(obj));
}

async function upstream(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${AIO}/stream/series/${target}.json`, { signal: ctrl.signal });
    if (!r.ok) return [];
    const data = await r.json();
    return data.streams || [];
  } catch (err) {
    console.error('upstream error', target, err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Which numberings to try for this request, in order of preference.
function targetsFor(imdb, s, e) {
  const m = MAP[imdb];
  if (!m || !s || !e) return [];
  const show = m.to || imdb;
  const list = m.episodes && m.episodes[`${Number(s)}:${Number(e)}`];
  if (list) return list.map((se) => `${show}:${se}`);
  if (m.offset !== undefined) return [`${show}:${Number(s) + m.offset}:${e}`];
  return [];
}

// "Open in the broadcaster's app" entries: external links, not video files.
function linksFor(imdb, s, e) {
  const m = MAP[imdb];
  const list = m && m.links && m.links[`${Number(s)}:${Number(e)}`];
  if (!list) return [];
  return list.map(([title, url]) => ({ name: '▶ BBC iPlayer', title, externalUrl: url }));
}

async function streamsFor(id) {
  const [imdb, s, e] = decodeURIComponent(id).split(':');
  const links = linksFor(imdb, s, e);
  const targets = targetsFor(imdb, s, e);
  if (!targets.length || !AIO) return { streams: links };
  const results = await Promise.all(targets.map(upstream));
  const i = results.findIndex((r) => r.length);
  if (i < 0) return { streams: links };
  console.log(`${id} -> ${targets[i]} (${results[i].length} streams)`);
  return { streams: links.concat(results[i]) };
}

// /test/<imdb>:<s>:<e> shows every candidate and its stream count (for checking a mapping).
async function testFor(id) {
  const [imdb, s, e] = decodeURIComponent(id).split(':');
  const targets = targetsFor(imdb, s, e);
  const results = await Promise.all(targets.map(upstream));
  return { id, tried: targets.map((t, i) => ({ target: t, streams: results[i].length })) };
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (path === '/' || path === '/manifest.json') return send(res, 200, manifest);
  const m = path.match(/^\/stream\/series\/(.+)\.json$/);
  if (m) return send(res, 200, await streamsFor(m[1]));
  const mm = path.match(/^\/meta\/series\/(.+)\.json$/);
  if (mm) return send(res, 200, await metaFor(mm[1]));
  const t = path.match(/^\/test\/(.+)$/);
  if (t) return send(res, 200, await testFor(t[1]));
  if (path === '/health') return send(res, 200, { ok: true, version: manifest.version, upstream: Boolean(AIO), meta: Boolean(XP), shows: Object.keys(MAP) });
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`Series Fix ${manifest.version} listening on ${PORT}; shows: ${Object.keys(MAP).join(', ')}; upstream set: ${Boolean(AIO)}`));

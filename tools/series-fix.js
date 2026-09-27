// Nuvio "series fix" add-on.
// For shows that the databases split in two (e.g. Bake Off: BBC years and
// Channel 4 years), Nuvio asks for the wrong series number. This add-on
// rewrites the request and asks AIOStreams for the numbering the releases use.
//
// Settings (environment variables):
//   AIOSTREAMS_URL  your AIOStreams install link (ends in /manifest.json). Required.
//   PORT            port to listen on (default 7020)
//   EXTRA_MAP       optional JSON to add shows, e.g.
//                   {"tt1234567":{"to":"tt7654321","offset":3}}

const http = require('http');

// Show we are asked for -> show and series offset AIOStreams should use.
const MAP = Object.assign({
  // The Great British Bake Off, Channel 4 years (2017 on). Its series 1 is UK series 8.
  tt21958588: { to: 'tt1877368', offset: 7 },
}, JSON.parse(process.env.EXTRA_MAP || '{}'));

const AIO = (process.env.AIOSTREAMS_URL || '').replace(/\/manifest\.json.*$/, '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 7020);

const manifest = {
  id: 'uk.markhale.seriesfix',
  version: '1.0.0',
  name: 'Series Fix',
  description: 'Fixes series numbering for split shows (e.g. Bake Off) and fetches streams from AIOStreams.',
  types: ['series'],
  catalogs: [],
  resources: [{ name: 'stream', types: ['series'], idPrefixes: Object.keys(MAP) }],
  idPrefixes: Object.keys(MAP),
};

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'max-age=300',
  });
  res.end(JSON.stringify(obj));
}

async function streamsFor(id) {
  const [imdb, s, e] = decodeURIComponent(id).split(':');
  const m = MAP[imdb];
  if (!m || !s || !e || !AIO) return { streams: [] };
  const target = `${m.to}:${Number(s) + m.offset}:${e}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${AIO}/stream/series/${target}.json`, { signal: ctrl.signal });
    if (!r.ok) return { streams: [] };
    const data = await r.json();
    return { streams: data.streams || [] };
  } catch (err) {
    console.error('upstream error', target, err.message);
    return { streams: [] };
  } finally {
    clearTimeout(timer);
  }
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (path === '/' || path === '/manifest.json') return send(res, 200, manifest);
  const m = path.match(/^\/stream\/series\/(.+)\.json$/);
  if (m) return send(res, 200, await streamsFor(m[1]));
  if (path === '/health') return send(res, 200, { ok: true, upstream: Boolean(AIO), shows: Object.keys(MAP) });
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`Series Fix listening on ${PORT}; shows: ${Object.keys(MAP).join(', ')}; upstream set: ${Boolean(AIO)}`));

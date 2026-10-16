// MT4Manual relay: a tiny dependency-free HTTPS-ready mailbox between the MT4 EA (on the user's PC)
// and the dashboard/rules engine (on the box). Both sides only make OUTBOUND requests to it.
//   EA  -> POST /v1/ea/sync      (snapshot + acks)   <- pending commands as text lines
//   box -> GET  /v1/state | /v1/account | /v1/positions | /v1/quotes | /v1/ticks?since=ms
//   box -> POST /v1/orders/{ticket}/modify {sl,tp} | /v1/orders/{ticket}/close {lots?} | /v1/orders {symbol,type,lots,sl,tp,comment}
//          (queued for the EA; waits up to ACK_WAIT_MS for the EA's ack, returns {ok, ticket?, error?, dryRun?})
// Auth: "Authorization: Bearer <token>" on every route (constant-time compare). Run behind TLS (any free host terminates it).
import http from 'node:http'; import crypto from 'node:crypto';

export function createRelay({ token, ackWaitMs = 8000, cmdTtlMs = 30000, maxTicks = 5000, now = () => Date.now() } = {}) {
  if (!token || token.length < 24) throw new Error('relay token missing/too short');
  const tok = Buffer.from(token);
  const st = { snap: null, snapAt: 0, ticks: [], queue: [], acks: new Map(), waiters: new Map(), seq: 0 };
  const authed = req => { const h = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    return h.length === tok.length && crypto.timingSafeEqual(h, tok); };
  const clean = s => String(s ?? '').replace(/[|\r\n]/g, ' ').slice(0, 31);
  const num = v => (v === undefined || v === null || v === '' ? '' : String(+v));
  const enqueue = cmd => new Promise(resolve => {
    const id = 'c' + now().toString(36) + (++st.seq).toString(36);
    const c = { id, at: now(), ...cmd }; st.queue.push(c);
    const timer = setTimeout(() => { st.waiters.delete(id); st.queue = st.queue.filter(x => x.id !== id);
      resolve({ ok: false, id, error: st.snapAt && now() - st.snapAt < 10000 ? 'ea_ack_timeout' : 'ea_offline' }); }, ackWaitMs);
    st.waiters.set(id, a => { clearTimeout(timer); resolve({ ...a, id }); });
  });
  const ack = a => { st.queue = st.queue.filter(x => x.id !== a.id); const w = st.waiters.get(a.id);
    const r = { ok: !!a.ok, ticket: a.ticket ? +a.ticket : undefined, error: a.error || undefined, dryRun: !!a.dryRun };
    if (w) { st.waiters.delete(a.id); w(r); } };
  const line = c => [c.id, c.op, c.ticket || 0, clean(c.symbol), clean(c.type), num(c.lots), num(c.sl), num(c.tp), clean(c.comment)].join('|');
  const sync = b => {
    for (const a of b.acks || []) ack(a);
    if (b.account) { st.snap = { account: b.account, positions: b.positions || [], quotes: b.quotes || {}, ea: b.ea || {} }; st.snapAt = now(); }
    for (const t of b.ticks || []) st.ticks.push(t); if (st.ticks.length > maxTicks) st.ticks.splice(0, st.ticks.length - maxTicks);
    st.queue = st.queue.filter(c => now() - c.at < cmdTtlMs);
    return st.queue.map(line).join('\n');
  };
  const body = req => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d.replace(/\0+$/, '') || '{}')); } catch (e) { rej(e); } }); });
  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const send = (code, o, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(o) : o); };
    if (p === '/health') return send(200, { ok: true, eaOnline: !!st.snapAt && now() - st.snapAt < 10000 });
    if (!authed(req)) return send(401, { error: 'unauthorized' });
    try {
      if (req.method === 'POST' && p === '/v1/ea/sync') return send(200, sync(await body(req)), 'text/plain');
      const age = st.snapAt ? now() - st.snapAt : null; const s = st.snap;
      if (req.method === 'GET') {
        if (p === '/v1/state') return send(200, { ...(s || {}), ageMs: age, online: age !== null && age < 10000 });
        if (!s) return send(503, { error: 'no_snapshot_yet' });
        if (p === '/v1/account') return send(200, { ...s.account, ageMs: age });
        if (p === '/v1/positions') return send(200, { positions: s.positions, ageMs: age });
        if (p === '/v1/quotes') return send(200, { quotes: s.quotes, ageMs: age });
        if (p === '/v1/ticks') { const since = +u.searchParams.get('since') || 0; return send(200, { ticks: st.ticks.filter(t => t.t > since) }); }
      }
      if (req.method === 'POST') {
        const b = await body(req); let m;
        if ((m = p.match(/^\/v1\/orders\/(\d+)\/modify$/))) return send(200, await enqueue({ op: 'modify', ticket: +m[1], sl: b.sl, tp: b.tp }));
        if ((m = p.match(/^\/v1\/orders\/(\d+)\/close$/))) return send(200, await enqueue({ op: 'close', ticket: +m[1], lots: b.lots }));
        if (p === '/v1/orders') {
          if (!b.symbol || !['buy', 'sell'].includes(b.type) || !(+b.lots > 0)) return send(400, { error: 'symbol, type buy|sell, lots>0 required' });
          return send(200, await enqueue({ op: 'open', symbol: b.symbol, type: b.type, lots: b.lots, sl: b.sl, tp: b.tp, comment: b.comment }));
        }
      }
      send(404, { error: 'not_found' });
    } catch (e) { send(400, { error: 'bad_request' }); }
  };
  return { handler, state: st };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { handler } = createRelay({ token: process.env.RELAY_TOKEN });
  const port = +process.env.PORT || 8796; http.createServer(handler).listen(port, process.env.HOST || '0.0.0.0', () => console.log('relay on :' + port));
}

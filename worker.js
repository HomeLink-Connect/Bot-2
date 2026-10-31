// ArnTech Pilot engine: Cloudflare Worker (OANDA practice account)
// Secrets: OANDA_TOKEN, OANDA_ACCOUNT, APP_KEY   KV binding: STATE
const PAIRS = { EUR_USD: { d: 5, pip: 1e-4 }, GBP_USD: { d: 5, pip: 1e-4 }, USD_JPY: { d: 3, pip: 0.01 }, AUD_USD: { d: 5, pip: 1e-4 } };
const DEF = { on: false, halted: false, dayStart: 0, dayKey: '', risk: 1, sl: 20, rr: 2, fast: 5, slow: 13, rsi: true, maxPos: 3, dailyLoss: 3, session: true, pairs: Object.keys(PAIRS) };
const NUM = ['risk', 'sl', 'rr', 'fast', 'slow', 'maxPos', 'dailyLoss'];
const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-app-key', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

const base = env => `/accounts/${env.OANDA_ACCOUNT}`;
async function oanda(env, path, opt = {}) {
  const r = await fetch(`https://${env.OANDA_HOST || 'api-fxpractice.oanda.com'}/v3${path}`, { ...opt, headers: { authorization: 'Bearer ' + env.OANDA_TOKEN, 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.errorMessage || 'OANDA ' + r.status);
  return j;
}
const getState = async env => ({ ...DEF, ...((await env.STATE.get('state', 'json')) || {}) });
const putState = (env, s) => env.STATE.put('state', JSON.stringify(s));
async function log(env, m) {
  const l = (await env.STATE.get('log', 'json')) || [];
  l.unshift({ t: Date.now(), m });
  await env.STATE.put('log', JSON.stringify(l.slice(0, 40)));
}

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map(v => (e = v * k + e * (1 - k))); };
const rsi = (a, n = 14) => { let g = 0, l = 0; for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; d >= 0 ? (g += d) : (l -= d); } return l ? 100 - 100 / (1 + g / l) : 100; };
function signal(c, s) {
  const f = ema(c, s.fast), w = ema(c, s.slow), n = c.length - 1, r = rsi(c);
  if (f[n - 1] <= w[n - 1] && f[n] > w[n] && (!s.rsi || r < 70)) return 1;
  if (f[n - 1] >= w[n - 1] && f[n] < w[n] && (!s.rsi || r > 30)) return -1;
  return 0;
}

async function killAll(env) {
  const t = (await oanda(env, base(env) + '/openTrades')).trades;
  for (const x of t) await oanda(env, `${base(env)}/trades/${x.id}/close`, { method: 'PUT', body: '{}' }).catch(() => {});
  return t.length;
}

async function run(env) {
  const s = await getState(env);
  if (!s.on || s.halted) return;
  const nav = +(await oanda(env, base(env) + '/summary')).account.NAV;
  const day = new Date().toISOString().slice(0, 10);
  if (s.dayKey !== day) { s.dayKey = day; s.dayStart = nav; await putState(env, s); }
  if ((nav - s.dayStart) / s.dayStart * 100 <= -s.dailyLoss) {
    await killAll(env); s.on = false; s.halted = true; await putState(env, s);
    return log(env, 'Daily loss limit reached. Positions closed and bot halted.');
  }
  const h = new Date().getUTCHours();
  if (s.session && (h < 7 || h >= 20)) return;
  const open = (await oanda(env, base(env) + '/openTrades')).trades;
  for (const ins of s.pairs) {
    if (open.length >= s.maxPos) break;
    if (open.some(t => t.instrument === ins) || !PAIRS[ins]) continue;
    const cs = (await oanda(env, `/instruments/${ins}/candles?granularity=M5&count=80&price=M`)).candles.filter(c => c.complete);
    const last = cs[cs.length - 1];
    // act once, right after a fresh M5 candle closes (cron runs every minute)
    if (!last || Date.now() - new Date(last.time).getTime() - 300000 > 70000) continue;
    const sg = signal(cs.map(c => +c.mid.c), s);
    if (!sg) continue;
    const P = PAIRS[ins], px = +last.mid.c, sl = s.sl * P.pip, tp = sl * s.rr, f = v => v.toFixed(P.d);
    const units = Math.max(1, Math.floor(nav * s.risk / 100 * (ins.endsWith('JPY') ? px : 1) / sl));
    try {
      await oanda(env, base(env) + '/orders', { method: 'POST', body: JSON.stringify({ order: { type: 'MARKET', instrument: ins, units: String(sg * units), timeInForce: 'FOK', stopLossOnFill: { price: f(px - sg * sl) }, takeProfitOnFill: { price: f(px + sg * tp) } } }) });
      open.push({ instrument: ins });
      await log(env, `${sg > 0 ? 'BUY' : 'SELL'} ${ins.replace('_', '/')} · ${units} units`);
    } catch (e) { await log(env, `Order failed ${ins}: ${e.message}`); }
  }
}

async function status(env) {
  let s = await getState(env);
  const [a, o, c, p] = await Promise.all([
    oanda(env, base(env) + '/summary'), oanda(env, base(env) + '/openTrades'),
    oanda(env, base(env) + '/trades?state=CLOSED&count=40'),
    oanda(env, base(env) + '/pricing?instruments=' + Object.keys(PAIRS).join(','))]);
  const nav = +a.account.NAV;
  if (!s.dayStart) { s.dayStart = nav; s.dayKey = new Date().toISOString().slice(0, 10); await putState(env, s); }
  const prices = {};
  p.prices.forEach(x => (prices[x.instrument] = (+x.bids[0].price + +x.asks[0].price) / 2));
  return {
    state: s, nav, bal: +a.account.balance, unrl: +a.account.unrealizedPL, prices,
    open: o.trades.map(t => ({ id: t.id, pair: t.instrument, dir: Math.sign(+t.currentUnits), entry: +t.price, sl: +t.stopLossOrder?.price || 0, tp: +t.takeProfitOrder?.price || 0, pnl: +t.unrealizedPL })),
    closed: c.trades.map(t => ({ pair: t.instrument, dir: Math.sign(+t.initialUnits), entry: +t.price, exit: +t.averageClosePrice, pnl: +t.realizedPL, t: Date.parse(t.closeTime) })),
    log: (await env.STATE.get('log', 'json')) || []
  };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    if (req.headers.get('x-app-key') !== env.APP_KEY) return out({ error: 'Wrong app key' }, 401);
    const path = new URL(req.url).pathname;
    try {
      if (path === '/api/status') return out(await status(env));
      const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      if (path === '/api/config') {
        const s = await getState(env);
        NUM.forEach(k => { if (b[k] > 0) s[k] = +b[k]; });
        ['on', 'rsi', 'session'].forEach(k => { if (typeof b[k] === 'boolean') s[k] = b[k]; });
        if (Array.isArray(b.pairs)) s.pairs = b.pairs.filter(x => PAIRS[x]);
        if (b.on && s.halted) return out({ error: 'Halted by daily loss limit. Tap "New trading day".' }, 400);
        await putState(env, s);
        if (typeof b.on === 'boolean') await log(env, b.on ? 'Bot started' : 'Bot paused');
        return out({ ok: true, state: s });
      }
      if (path === '/api/kill') {
        const s = await getState(env); const n = await killAll(env); s.on = false; await putState(env, s);
        await log(env, `Kill switch: ${n} trade(s) closed`); return out({ ok: true });
      }
      if (path === '/api/close') { await oanda(env, `${base(env)}/trades/${b.id}/close`, { method: 'PUT', body: '{}' }); return out({ ok: true }); }
      if (path === '/api/newday') {
        const s = await getState(env); s.dayStart = +(await oanda(env, base(env) + '/summary')).account.NAV; s.halted = false; await putState(env, s);
        await log(env, 'New trading day started'); return out({ ok: true });
      }
      return out({ error: 'Not found' }, 404);
    } catch (e) { return out({ error: e.message }, 500); }
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(run(env).catch(e => log(env, 'Engine error: ' + e.message))); }
};

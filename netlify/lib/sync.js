/* Sincronización con Alegra que corre en el servidor, aunque el panel esté cerrado.
   1) Las ventas de la página que aún no están en Alegra se envían como factura (Alegra descuenta el inventario).
   2) Las cantidades de Alegra se copian a la tienda (config/stock): así también se descuentan las ventas hechas en el local.
   3) Se calcula qué productos se están acabando (private/syncstate) para el panel y, más adelante, para el celular.
   Se ejecuta: cada 5 minutos (alegra-cron.mjs), al entrar un pedido (alegra-sync.js) y con el botón del panel. */
const fs = require('./fs');
const { makeApi, allItems } = require('./alegra');

const MAX_AGE = 7 * 86400000;      /* en automático no se envían ventas de hace más de 7 días */
const RUN_LOCK_MS = 120000;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = () => { const d = new Date(Date.now() - 5 * 3600000); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };   /* hora de Colombia */

/* Un pedido pagado con Wompi solo vale si Wompi lo aprobó (lo escribe el servidor, nunca la página) */
const unpaid = (o) => o.pay === 'wompi' && o.payStatus !== 'APPROVED';
const sendable = (o) => o && !o.synced && o.status !== 'Cancelado' && !unpaid(o) && Array.isArray(o.lines) && o.lines.length > 0 && o.lines.length <= 60;

async function acquireRun() {
  const now = Date.now();
  if (await fs.createDoc('locks', 'run', { at: now })) return true;
  const l = await fs.getDoc('locks', 'run');
  if (l && now - Number(l.at || 0) < RUN_LOCK_MS) return false;
  await fs.patchDoc('locks', 'run', { at: now });
  return true;
}
const releaseRun = () => fs.delDoc('locks', 'run').catch(() => {});

async function ensureClient(api, saved) {
  if (saved) return saved;
  const name = 'Pedidos web MAD BEER';
  const found = await api('GET', '/contacts?start=0&limit=10&query=' + encodeURIComponent(name));
  const arr = Array.isArray(found) ? found : (found && found.data) || [];
  const hit = arr.filter((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase())[0];
  if (hit) return hit.id;
  const c = await api('POST', '/contacts', { name, type: ['client'] });
  return c.id;
}

/* opts.force: viene del botón del panel (ignora el interruptor automático y la edad del pedido)
   opts.only: código de un pedido recién hecho; solo se envía ese y se descuenta del stock */
async function runSync(opts) {
  opts = opts || {};
  const out = { ran: false, sent: [], skipped: [], error: '', stock: 0, news: 0, skip: '' };
  const settings = (await fs.getDoc('private', 'settings')) || {};
  const al = settings.alegra || {};
  if (!al.email || !al.token) { out.skip = 'Alegra sin conectar'; return out; }
  if (!opts.force && !settings.autoSync) {
    out.skip = 'El envío automático está apagado';
    const cur = await fs.getDoc('config', 'stock');
    if (cur && cur.on === true) await fs.patchDoc('config', 'stock', { on: false });
    return out;
  }
  if (!(await acquireRun())) { out.skip = 'Ya hay una sincronización en curso'; return out; }

  const t0 = Date.now(), log = [];
  const say = (m) => log.push(hhmm() + ' · ' + m);
  try {
    out.ran = true;
    const api = makeApi(al.email, al.token);
    const catalog = (await fs.getDoc('config', 'catalog')) || { products: [] };
    const prods = Array.isArray(catalog.products) ? catalog.products : [];
    const byId = {}; prods.forEach((p) => { byId[p.id] = p; });
    const prev = (await fs.getDoc('private', 'syncstate')) || {};
    let clientId = prev.clientId || al.clientId || '';

    /* ---- 1) Ventas pendientes -> facturas ---- */
    let pending = (await fs.whereEq('orders', 'synced', false, 200)).filter(sendable);
    if (opts.only) pending = pending.filter((o) => o.code === opts.only);
    else if (!opts.force) pending = pending.filter((o) => Date.now() - Number(o.ts || 0) < MAX_AGE);
    pending.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const stillPending = [];
    let stop = false;
    for (const o of pending) {
      if (stop) { stillPending.push(o); continue; }
      /* La página arma el pedido, así que se revisa que cantidades y precios sean los del catálogo antes de facturar */
      const bad = o.lines.filter((l) => { const p = byId[l.id]; return !(Number(l.qty) >= 1 && Number(l.qty) <= 500 && Number.isInteger(Number(l.qty))) || (p && !opts.force && Number(l.price) !== Number(p.price)); });
      if (bad.length) {
        const why = 'Cantidades o precios distintos al catálogo; revisa el pedido y envíalo a mano con «Enviar pendientes».';
        out.skipped.push({ code: o.code, why }); stillPending.push(o);
        if (o.syncNote !== why) { say(o.code + ' no se envió. ' + why); await fs.patchDoc('orders', o.code, { syncNote: why }).catch(() => {}); }
        continue;
      }
      const miss = [];
      const items = o.lines.map((l) => {
        const p = byId[l.id];
        if (!p || !p.alegraId) { miss.push(p ? p.name : 'producto ' + l.id); return null; }
        return { id: Number(p.alegraId), price: Number(l.price), quantity: Number(l.qty) };
      });
      if (miss.length) {
        const why = 'Faltan enlazar con Alegra: ' + miss.join(', ');
        out.skipped.push({ code: o.code, why }); stillPending.push(o);
        if (o.syncNote !== why) { say(o.code + ' no se envió. ' + why); await fs.patchDoc('orders', o.code, { syncNote: why }).catch(() => {}); }
        continue;
      }
      if (!(await fs.createDoc('locks', o.code, { at: Date.now() }))) { stillPending.push(o); continue; }   /* otro proceso la está enviando */
      try {
        clientId = await ensureClient(api, clientId);
        const day = o.day || new Date(Number(o.ts || Date.now()) - 5 * 3600000).toISOString().slice(0, 10);
        const obs = ('Pedido web ' + o.code + ' · ' + o.name + ' · ' + o.phone + ' · ' + (o.mode === 'domicilio' ? 'domicilio a ' + o.addr : 'recoger en el local') + ' · ' +
          (o.pay === 'wompi' ? 'pagado en línea' : 'efectivo al recibir') + (o.fee ? ' · domicilio cobrado $' + o.fee : '')).slice(0, 480);
        const r = await api('POST', '/invoices', { date: day, dueDate: day, client: clientId, status: al.invoiceStatus === 'draft' ? 'draft' : 'open', items, observations: obs });
        const num = String((r.numberTemplate && r.numberTemplate.fullNumber) || r.id || '');
        out.sent.push(o.code); say('Venta ' + o.code + ' enviada a Alegra' + (num ? ' (factura ' + num + ')' : ''));
        try { await fs.patchDoc('orders', o.code, { synced: true, stockApplied: true, alegra: num, syncNote: '' }); await fs.delDoc('locks', o.code); }
        catch (e) { say('Ojo: la factura de ' + o.code + ' se creó en Alegra pero no se pudo marcar aquí. Revísala para no duplicarla.'); }
      } catch (e) {
        await fs.delDoc('locks', o.code).catch(() => {});
        stillPending.push(o); out.error = e.message; say(o.code + ': Alegra no la recibió. ' + e.message);
        await fs.patchDoc('orders', o.code, { syncNote: 'Alegra: ' + e.message }).catch(() => {});
        if (!(e.status >= 400 && e.status < 500) || e.status === 401 || e.status === 429) stop = true;   /* error del pedido: se sigue con el resto; error general: se para */
      }
    }

    /* ---- 2) Cantidades ---- */
    const curStock = (await fs.getDoc('config', 'stock')) || {};
    const q = Object.assign({}, curStock.q || {});
    let news = prev.news || 0, pulled = false;
    if (opts.only) {
      out.sent.forEach((code) => {
        const o = pending.filter((x) => x.code === code)[0];
        (o ? o.lines : []).forEach((l) => { const p = byId[l.id]; const base = q[l.id] != null ? q[l.id] : (p ? Number(p.stock) || 0 : 0); q[l.id] = Math.max(0, base - Number(l.qty)); });
      });
    } else {
      try {
        const items = await allItems(api, t0 + 22000);
        const idx = {}, linkedIds = {};
        items.forEach((it) => { idx[String(it.id)] = it; });
        prods.forEach((p) => {
          if (!p.alegraId) return;
          linkedIds[String(p.alegraId)] = 1;
          const it = idx[String(p.alegraId)];
          if (it && it.qty != null) q[p.id] = Math.max(0, Math.round(it.qty));
        });
        /* Lo que ya se vendió en la página pero aún no llegó a Alegra se descuenta aquí */
        stillPending.forEach((o) => o.lines.forEach((l) => { if (q[l.id] != null) q[l.id] = Math.max(0, q[l.id] - Number(l.qty)); }));
        news = items.filter((it) => it.qty != null && !linkedIds[String(it.id)]).length;
        pulled = true; out.stock = items.length;
      } catch (e) {
        out.error = out.error || e.message; say('No se pudo leer el inventario de Alegra. ' + e.message);
      }
    }
    const changed = JSON.stringify(q) !== JSON.stringify(curStock.q || {});
    if (changed || curStock.on !== true) {
      await fs.patchDoc('config', 'stock', { q, at: Date.now(), on: true, n: Object.keys(q).length });
      if (pulled && changed) { const nn = Object.keys(q).filter((k) => (curStock.q || {})[k] !== q[k]).length; say('Inventario al día: ' + nn + ' cantidades cambiaron'); }
    }

    /* ---- 3) Productos que se están acabando (para el panel y para el celular) ---- */
    const low = prods.filter((p) => !(p.fromAlegra && p.hidden)).map((p) => ({ p, qty: q[p.id] != null ? q[p.id] : Number(p.stock) || 0 }))
      .filter((x) => x.qty <= (Number(x.p.min) || 0)).sort((a, b) => a.qty - b.qty).slice(0, 150)
      .map((x) => ({ id: x.p.id, name: x.p.name, size: x.p.size || '', qty: x.qty, min: Number(x.p.min) || 0 }));

    const oldLog = Array.isArray(prev.log) ? prev.log : [];
    await fs.patchDoc('private', 'syncstate', {
      at: Date.now(), ok: !out.error, error: out.error, sent: out.sent.length, pending: stillPending.length, news, low, clientId: clientId || '',
      log: log.reverse().concat(oldLog).slice(0, 40)
    });
    out.news = news;
  } finally { await releaseRun(); }
  return out;
}

module.exports = { runSync, sendable, unpaid };

/* Sincronización con Alegra que corre en el servidor, aunque el panel esté cerrado.
   1) Las ventas de la página que aún no están en Alegra se envían como factura (Alegra descuenta el inventario).
   2) Las cantidades de Alegra se copian a la tienda (config/stock): así también se descuentan las ventas hechas en el local.
   3) Se calcula qué productos se están acabando (private/syncstate) para el panel y, más adelante, para el celular.
   Se ejecuta: cada 5 minutos (alegra-cron.mjs), al entrar un pedido (alegra-sync.js) y con el botón del panel. */
const fs = require('./fs');
const { makeApi, allItems } = require('./alegra');
const push = require('./push');

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

/* Nombre del cliente genérico al que se le facturan las ventas de la página */
const CLIENT_NAME = 'Pedidos web MAD BEER';
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function clientName(c) {
  const o = c && c.nameObject;
  return norm((c && c.name) || (o && [o.firstName, o.secondName, o.lastName, o.secondLastName].filter(Boolean).join(' ')) || '');
}
async function ensureClient(api, saved) {
  if (saved) return saved;
  const found = await api('GET', '/contacts?start=0&limit=30&query=' + encodeURIComponent(CLIENT_NAME));
  const arr = Array.isArray(found) ? found : (found && found.data) || [];
  const hit = arr.filter((c) => clientName(c) === norm(CLIENT_NAME))[0];
  if (hit) return hit.id;
  /* Las cuentas de Alegra con facturación electrónica piden el nombre en partes (nameObject): se prueban las dos formas */
  const nameObject = { firstName: 'Pedidos web', lastName: 'MAD BEER' };
  const tries = [{ name: CLIENT_NAME, type: ['client'] }, { nameObject, type: ['client'] }, { name: CLIENT_NAME, nameObject, type: ['client'] }];
  let last = null;
  for (const body of tries) {
    try { const c = await api('POST', '/contacts', body); if (c && c.id) return c.id; }
    catch (e) { last = e; if (!(e.status >= 400 && e.status < 500) || e.status === 401 || e.status === 429) throw e; }
  }
  const err = new Error('No se pudo crear el cliente «' + CLIENT_NAME + '» en Alegra (' + (last && last.message) + '). Créalo a mano en Alegra (Contactos > Nuevo, tipo Cliente) con ese nombre y vuelve a sincronizar.');
  err.general = true;   /* no tiene sentido seguir con los demás pedidos en esta pasada */
  throw err;
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
    /* Precios que Alegra mandó en la pasada anterior. Un pedido hecho justo antes del cambio (con el precio viejo) también se acepta: se factura al precio que pagó el cliente. */
    const stock0 = (await fs.getDoc('config', 'stock')) || {};
    const effPrice = (p) => (stock0.pr && Number(stock0.pr[p.id]) > 0 ? Number(stock0.pr[p.id]) : Number(p.price));
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
      const bad = o.lines.filter((l) => { const p = byId[l.id]; return !(Number(l.qty) >= 1 && Number(l.qty) <= 500 && Number.isInteger(Number(l.qty))) || (p && !opts.force && Number(l.price) !== effPrice(p) && Number(l.price) !== Number(p.price)); });
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
        /* La tienda cobra con IVA; Alegra suma el IVA del ítem encima, así que se le manda el precio sin IVA para que la factura dé lo mismo que pagó el cliente */
        const rt = al.priceTax === 'none' ? 0 : Number(stock0.tx && stock0.tx[p.id]) || 0;
        return { id: Number(p.alegraId), price: rt > 0 ? Math.round((Number(l.price) / (1 + rt)) * 100) / 100 : Number(l.price), quantity: Number(l.qty) };
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
        if (e.general || !(e.status >= 400 && e.status < 500) || e.status === 401 || e.status === 429) stop = true;   /* error del pedido: se sigue con el resto; error general: se para */
      }
    }

    /* ---- 2) Cantidades ---- */
    const curStock = (await fs.getDoc('config', 'stock')) || {};
    const q = Object.assign({}, curStock.q || {});
    let news = prev.news || 0, pulled = false;
    const pr = Object.assign({}, curStock.pr || {}), tx = Object.assign({}, curStock.tx || {}); let priceChanged = null, priceSuspect = [];
    if (opts.only) {
      out.sent.forEach((code) => {
        const o = pending.filter((x) => x.code === code)[0];
        (o ? o.lines : []).forEach((l) => { const p = byId[l.id]; const base = q[l.id] != null ? q[l.id] : (p ? Number(p.stock) || 0 : 0); q[l.id] = Math.max(0, base - Number(l.qty)); });
      });
    } else {
      try {
        const items = await allItems(api, t0 + 22000, { priceList: al.priceList, priceTax: al.priceTax });
        const idx = {}, linkedIds = {};
        items.forEach((it) => { idx[String(it.id)] = it; });
        prods.forEach((p) => {
          if (!p.alegraId) return;
          linkedIds[String(p.alegraId)] = 1;
          const it = idx[String(p.alegraId)];
          if (it && it.qty != null) q[p.id] = Math.max(0, Math.round(it.qty));
          /* Los precios salen de Alegra (lista «General»): así nunca se desactualizan */
          if (it) { if (it.taxRate > 0) tx[p.id] = it.taxRate; else delete tx[p.id]; }
          if (al.priceAuto !== false && it && it.suspect) {
            /* El precio de Alegra no supera el costo de compra: casi seguro es la lista equivocada. No se toca el precio de la tienda. */
            priceChanged = priceChanged || [];
            priceSuspect.push({ name: p.name + (p.size ? ' ' + p.size : ''), price: it.price, cost: it.cost, list: it.listName });
          } else if (al.priceAuto !== false && it && it.price > 0) {
            priceChanged = priceChanged || [];
            const np = Math.round(it.price), was = Number(pr[p.id]) > 0 ? Number(pr[p.id]) : Number(p.price);
            if (np !== was) priceChanged.push({ name: p.name + (p.size ? ' ' + p.size : ''), from: was, to: np });
            pr[p.id] = np;
          }
        });
        /* Lo que ya se vendió en la página pero aún no llegó a Alegra se descuenta aquí */
        stillPending.forEach((o) => o.lines.forEach((l) => { if (q[l.id] != null) q[l.id] = Math.max(0, q[l.id] - Number(l.qty)); }));
        news = items.filter((it) => it.qty != null && !linkedIds[String(it.id)]).length;
        pulled = true; out.stock = items.length;
      } catch (e) {
        out.error = out.error || e.message; say('No se pudo leer el inventario de Alegra. ' + e.message);
      }
    }
    if (pulled && priceSuspect.length) say('Ojo: ' + priceSuspect.length + ' productos tienen en Alegra un precio que no supera el costo de compra (ej.: ' + priceSuspect.slice(0, 3).map((x) => x.name).join(', ') + '). No se cambió su precio en la tienda. Revisa la lista de precios de venta en Alegra.');
    const changed = JSON.stringify(q) !== JSON.stringify(curStock.q || {});
    const pChanged = JSON.stringify(pr) !== JSON.stringify(curStock.pr || {}) || JSON.stringify(tx) !== JSON.stringify(curStock.tx || {});
    if (changed || pChanged || curStock.on !== true) {
      await fs.patchDoc('config', 'stock', { q, pr, tx, at: Date.now(), on: true, n: Object.keys(q).length });
      if (pulled && changed) { const nn = Object.keys(q).filter((k) => (curStock.q || {})[k] !== q[k]).length; say('Inventario al día: ' + nn + ' cantidades cambiaron'); }
      if (pulled && priceChanged && priceChanged.length) say('Precios al día: ' + priceChanged.length + ' precios cambiaron respecto a Alegra');
      
    }

    /* ---- 3) Productos que se están acabando (para el panel y para el celular) ---- */
    const low = prods.filter((p) => !(p.fromAlegra && p.hidden)).map((p) => ({ p, qty: q[p.id] != null ? q[p.id] : Number(p.stock) || 0 }))
      .filter((x) => x.qty <= (Number(x.p.min) || 0)).sort((a, b) => a.qty - b.qty).slice(0, 150)
      .map((x) => ({ id: x.p.id, name: x.p.name, size: x.p.size || '', qty: x.qty, min: Number(x.p.min) || 0 }));

    const oldLog = Array.isArray(prev.log) ? prev.log : [];
    await fs.patchDoc('private', 'syncstate', {
      at: Date.now(), ok: !out.error, error: out.error, sent: out.sent.length, pending: stillPending.length, news, low, clientId: clientId || '',
      priceN: priceChanged ? priceChanged.length : (prev.priceN || 0), priceChanged: priceChanged ? priceChanged.slice(0, 15) : (prev.priceChanged || []), priceSuspectN: priceSuspect.length, priceSuspect: priceSuspect.slice(0, 10), priceAt: priceChanged && priceChanged.length ? Date.now() : (prev.priceAt || 0),
      log: log.reverse().concat(oldLog).slice(0, 40)
    });
    out.news = news;

    /* Aviso al celular: solo los que ENTRAN en «se está acabando» o se agotan (no se repite mientras sigan bajos).
       La primera vez solo se toma la foto de cómo están, sin avisar. */
    if (Array.isArray(prev.low) && settings.notif && settings.notif.lowStock !== false) {
      const was = {}; prev.low.forEach((x) => { was[x.id] = x; });
      const fresh = low.filter((x) => !was[x.id] || (was[x.id].qty > 0 && x.qty <= 0));
      if (fresh.length) { try { await push.notifyLow(fresh); } catch (e) { /* el aviso es un extra: no frena la sincronización */ } }
    }
  } finally { await releaseRun(); }
  return out;
}

module.exports = { runSync, sendable, unpaid };

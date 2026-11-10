/* Avisos al celular (Web Push), sin dependencias.
   - Las claves VAPID (la «firma» del negocio ante los servicios de avisos) se crean solas la primera vez y se guardan en private/vapid.
   - Cada celular activado queda en la colección pushsubs (solo el servidor la lee y escribe).
   - El mensaje va cifrado con aes128gcm (RFC 8291) y firmado con VAPID (RFC 8292). */
const crypto = require('crypto');
const fs = require('./fs');

const SUBJECT = 'mailto:madbeerlicores@gmail.com';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const subId = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 40);
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

/* ---------- Claves VAPID ---------- */
async function vapid() {
  let v = await fs.getDoc('private', 'vapid');
  if (v && v.pub && v.priv) return v;
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const fresh = { pub: b64u(e.getPublicKey()), priv: b64u(e.getPrivateKey()), at: Date.now() };
  if (await fs.createDoc('private', 'vapid', fresh)) return fresh;
  return (await fs.getDoc('private', 'vapid')) || fresh;   /* otro proceso la creó primero */
}
async function publicKey() { return (await vapid()).pub; }

function vapidJwt(v, audience) {
  const pub = unb64u(v.pub);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: v.priv, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) }, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}

/* ---------- Cifrado del mensaje (RFC 8291, un solo bloque) ----------
   opts.asPrivate y opts.salt solo se usan en las pruebas con el ejemplo del RFC */
function encrypt(plain, uaPublic, authSecret, opts) {
  opts = opts || {};
  const as = crypto.createECDH('prime256v1');
  if (opts.asPrivate) as.setPrivateKey(opts.asPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const secret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const salt = opts.salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

/* ---------- Envío ---------- */
async function sendOne(v, s, data) {
  const url = new URL(s.endpoint);
  const body = encrypt(Buffer.from(JSON.stringify(data)), unb64u(s.p256dh), unb64u(s.auth));
  const r = await fetch(s.endpoint, {
    method: 'POST',
    headers: { Authorization: 'vapid t=' + vapidJwt(v, url.origin) + ', k=' + v.pub, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
    body, signal: AbortSignal.timeout(8000)
  });
  return r.status;
}

/* Manda un aviso a todos los celulares activados. Quita los que ya no existen (404/410). */
async function sendAll(data) {
  const out = { sent: 0, removed: 0, failed: 0, devices: 0 };
  const subs = await fs.whereEq('pushsubs', 'on', true, 50);
  out.devices = subs.length;
  if (!subs.length) return out;
  const v = await vapid();
  await Promise.all(subs.map(async (s) => {
    try {
      const st = await sendOne(v, s, data);
      if (st >= 200 && st < 300) out.sent++;
      else if (st === 404 || st === 410) { out.removed++; await fs.delDoc('pushsubs', s._id).catch(() => {}); }
      else out.failed++;
    } catch (e) { out.failed++; }
  }));
  return out;
}

/* ---------- Celulares ---------- */
async function subscribe(sub, ua) {
  const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' && unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length >= 16;
  if (!ok) throw new Error('Suscripción inválida');
  const id = subId(sub.endpoint);
  await fs.patchDoc('pushsubs', id, { on: true, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, ua: String(ua || '').slice(0, 160), at: Date.now() });
  return id;
}
async function unsubscribe(endpoint) { await fs.delDoc('pushsubs', subId(endpoint)); return true; }

/* ---------- Avisos del negocio ---------- */
/* Pedido nuevo. Un pedido con Wompi solo avisa cuando el pago está aprobado. Una sola vez por pedido. */
async function notifyOrder(code) {
  const o = await fs.getDoc('orders', code);
  if (!o || o.status === 'Cancelado' || (o.pay === 'wompi' && o.payStatus !== 'APPROVED')) return { skipped: true };
  if (!(await fs.createDoc('locks', 'push_' + code, { at: Date.now() }))) return { skipped: true, dup: true };
  const n = Array.isArray(o.lines) ? o.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0) : 0;
  const how = o.mode === 'domicilio' ? 'Domicilio' : 'Recoger';
  const pay = o.pay === 'wompi' ? 'pagado en línea' : 'efectivo';
  return sendAll({ title: 'Pedido nuevo ' + code, body: [o.name || 'Cliente', money(o.total), how, n + (n === 1 ? ' producto' : ' productos'), pay].join(' · '), tag: code, url: '/#panel' });
}
/* Productos que acaban de entrar en «se está acabando» o de agotarse */
async function notifyLow(items) {
  if (!items || !items.length) return { skipped: true };
  const one = items[0];
  const say = (x) => x.name + (x.size ? ' ' + x.size : '') + (x.qty <= 0 ? ' (agotado)' : ' (quedan ' + x.qty + ')');
  const body = items.length === 1 ? say(one) : items.slice(0, 4).map(say).join(', ') + (items.length > 4 ? ' y ' + (items.length - 4) + ' más' : '');
  return sendAll({ title: items.length === 1 ? 'Se está acabando' : items.length + ' productos se están acabando', body: body.slice(0, 300), tag: 'low', url: '/#panel' });
}

/* Red de seguridad (la usa el cron): pedidos de los últimos 30 minutos que aún no avisaron */
async function sweepOrders() {
  const list = await require('./fs').whereEq('orders', 'status', 'Recibido', 50);
  let n = 0;
  for (const o of list) {
    if (Date.now() - Number(o.ts || 0) > 30 * 60000 || !/^MB-[A-Z0-9]{6}$/.test(o._id)) continue;
    const r = await notifyOrder(o._id);
    if (!r.skipped) n++;
  }
  return n;
}

module.exports = { sweepOrders, publicKey, subscribe, unsubscribe, sendAll, notifyOrder, notifyLow, encrypt, vapidJwt, vapid };

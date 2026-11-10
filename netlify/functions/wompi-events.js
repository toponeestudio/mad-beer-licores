/* Wompi avisa aquí cuando cambia el estado de un pago (evento transaction.updated).
   Se verifica la firma con WOMPI_EVENTS_SECRET; sin firma válida no se hace nada.
   Si el pago se aprueba: el pedido queda pagado, se envía a Alegra y el panel lo muestra con su sonido. */
const crypto = require('crypto');
const fs = require('../lib/fs');
const { check } = require('../lib/pricing');

const ok = (o) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || { ok: true }) });
const pick = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método no permitido' };
  const secret = process.env.WOMPI_EVENTS_SECRET;
  if (!secret) return { statusCode: 503, body: 'Falta WOMPI_EVENTS_SECRET' };
  let ev; try { ev = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'JSON inválido' }; }
  const sig = ev.signature || {};
  const props = Array.isArray(sig.properties) ? sig.properties : [];
  const text = props.map((p) => pick(ev.data, p)).join('') + ev.timestamp + secret;
  const sum = crypto.createHash('sha256').update(text).digest('hex');
  if (!sig.checksum || sum.toLowerCase() !== String(sig.checksum).toLowerCase()) return { statusCode: 401, body: 'Firma inválida' };
  if (ev.event !== 'transaction.updated') return ok({ ignored: ev.event });
  const t = (ev.data && ev.data.transaction) || {};
  const code = String(t.reference || '').split('_')[0].toUpperCase();
  if (!/^MB-[A-Z0-9]{6}$/.test(code)) return ok({ ignored: 'reference' });
  try {
    const o = await fs.getDoc('orders', code);
    if (!o) return ok({ ignored: 'sin pedido' });
    if (o.payStatus === 'APPROVED') return ok({ already: true });
    const patch = { payStatus: String(t.status || ''), wompiId: String(t.id || ''), payMethod: String(t.payment_method_type || '') };
    if (t.status === 'APPROVED') {
      const pr = await check(o);
      if (!pr.ok || Math.round(pr.total * 100) !== Number(t.amount_in_cents)) { patch.payStatus = 'REVISAR_VALOR'; await fs.patchDoc('orders', code, patch); return ok({ revisar: true }); }
      patch.paid = true;
    }
    await fs.patchDoc('orders', code, patch);
    if (t.status === 'APPROVED') { try { await require('../lib/push').notifyOrder(code); } catch (e) { /* el cron lo reintenta */ } }
    if (t.status === 'APPROVED') { try { await require('../lib/sync').runSync({ only: code }); } catch (e) { /* el cron lo reintenta */ } }
    return ok({ updated: code, status: t.status });
  } catch (e) { return { statusCode: 500, body: e.message }; }
};

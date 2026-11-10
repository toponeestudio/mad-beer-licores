/* Sincronización con Alegra pedida desde la página.
   - { action:'order', code }  la tienda lo llama al hacerse un pedido en efectivo: envía esa venta a Alegra y descuenta el stock al instante.
     No necesita sesión: solo actúa sobre un pedido que existe, es reciente y todavía no se envió. Nunca devuelve errores al cliente.
   - { action:'sync', idToken }  botón del panel: envía todo lo pendiente y trae el inventario ahora mismo (solo el correo del negocio). */
const fs = require('../lib/fs');
const { resp, isAdmin } = require('../lib/common');
const { runSync, sendable } = require('../lib/sync');
const push = require('../lib/push');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Solicitud inválida' }); }

  if (b.action === 'order') {
    const code = String(b.code || '').toUpperCase();
    if (!/^MB-[A-Z0-9]{6}$/.test(code)) return resp(400, { ok: false });
    try {
      const o = await fs.getDoc('orders', code);
      if (o && Date.now() - Number(o.ts || 0) <= 15 * 60000) { try { await push.notifyOrder(code); } catch (e) { /* el cron lo reintenta */ } }
      if (!o || !sendable(o) || Date.now() - Number(o.ts || 0) > 15 * 60000) return resp(200, { ok: true, skipped: true });
      const r = await runSync({ only: code });
      return resp(200, { ok: true, sent: r.sent.length });
    } catch (e) { return resp(200, { ok: false }); }   /* el pedido ya quedó guardado; el cron lo reintenta */
  }

  if (b.action === 'sync') {
    let ok = false;
    try { ok = await isAdmin(b.idToken); } catch (e) { return resp(502, { error: 'No se pudo comprobar tu sesión. Intenta de nuevo.' }); }
    if (!ok) return resp(401, { error: 'Sin permiso. Entra al panel con el correo del negocio.' });
    try {
      const r = await runSync({ force: true });
      return resp(200, { ran: r.ran, sent: r.sent, skipped: r.skipped, error: r.error, skip: r.skip, stock: r.stock, news: r.news });
    } catch (e) { return resp(502, { error: e.message || 'No se pudo sincronizar' }); }
  }
  return resp(400, { error: 'Acción desconocida' });
};

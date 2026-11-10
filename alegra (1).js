/* Servicio seguro entre la página de MAD BEER y la API de Alegra.
   - Solo responde si la persona entró al panel con el correo del negocio (se comprueba con Firebase).
   - El correo y el token de Alegra llegan por HTTPS desde el panel y no se guardan aquí.
   Acciones: test, items, client, invoice */
const { resp, ADMIN, isAdmin } = require('../lib/common');
const { makeApi, normItem } = require('../lib/alegra');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Solicitud inválida' }); }
  let ok = false;
  try { ok = await isAdmin(b.idToken); } catch (e) { return resp(502, { error: 'No se pudo comprobar tu sesión. Intenta de nuevo.' }); }
  if (!ok) return resp(401, { error: 'Sin permiso. Entra al panel con el correo del negocio.' });
  if (!b.email || !b.token) return resp(400, { error: 'Falta el correo o el token de Alegra.' });

  const call = makeApi(b.email, b.token);
  const p = b.payload || {};
  try {
    if (b.action === 'test') {
      const l = await call('GET', '/items?start=0&limit=1&metadata=true');
      const total = l && l.metadata && l.metadata.total != null ? l.metadata.total : null;
      return resp(200, { ok: true, total });
    }
    if (b.action === 'items') {
      const start = Math.max(0, parseInt(p.start, 10) || 0);
      const l = await call('GET', '/items?start=' + start + '&limit=30&status=active&mode=advanced');
      const arr = Array.isArray(l) ? l : (l && l.data) || [];
      return resp(200, { items: arr.map(normItem) });
    }
    if (b.action === 'client') {
      const name = String(p.name || 'Pedidos web MAD BEER').slice(0, 80);
      const found = await call('GET', '/contacts?start=0&limit=10&query=' + encodeURIComponent(name));
      const arr = Array.isArray(found) ? found : (found && found.data) || [];
      const hit = arr.filter((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase())[0];
      if (hit) return resp(200, { id: hit.id });
      const c = await call('POST', '/contacts', { name, type: ['client'] });
      return resp(200, { id: c.id });
    }
    if (b.action === 'invoice') {
      const items = Array.isArray(p.items) ? p.items.map((i) => ({ id: Number(i.id), price: Number(i.price), quantity: Number(i.quantity) })) : [];
      if (!p.client || !items.length || items.some((i) => !i.id || !(i.quantity > 0) || !(i.price >= 0))) return resp(400, { error: 'Datos de la factura incompletos.' });
      const body = { date: p.date, dueDate: p.dueDate || p.date, client: p.client, status: p.status === 'draft' ? 'draft' : 'open', items, observations: String(p.observations || '').slice(0, 480) };
      const r = await call('POST', '/invoices', body);
      return resp(200, { id: r.id, number: (r.numberTemplate && r.numberTemplate.fullNumber) || '' });
    }
    return resp(400, { error: 'Acción desconocida' });
  } catch (e) {
    return resp(e.status && e.status >= 400 && e.status < 500 ? 400 : 502, { error: e.message || 'Error al hablar con Alegra' });
  }
};

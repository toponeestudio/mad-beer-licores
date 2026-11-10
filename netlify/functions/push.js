/* Avisos al celular del negocio.
   - { action:'key' }                           clave pública para que el celular se suscriba (no necesita sesión).
   - { action:'subscribe', idToken, sub }       activa este celular.
   - { action:'unsubscribe', idToken, endpoint } lo desactiva.
   - { action:'test', idToken }                 manda un aviso de prueba a todos los celulares activados.
   Todo lo que cambia algo exige la sesión del correo del negocio. */
const { resp, isAdmin } = require('../lib/common');
const push = require('../lib/push');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Solicitud inválida' }); }
  try {
    if (b.action === 'key') return resp(200, { key: await push.publicKey() });
    if (['subscribe', 'unsubscribe', 'test'].indexOf(b.action) < 0) return resp(400, { error: 'Acción desconocida' });
    let ok = false;
    try { ok = await isAdmin(b.idToken); } catch (e) { return resp(502, { error: 'No se pudo comprobar tu sesión. Intenta de nuevo.' }); }
    if (!ok) return resp(401, { error: 'Sin permiso. Entra al panel con el correo del negocio.' });
    if (b.action === 'subscribe') { await push.subscribe(b.sub, (event.headers || {})['user-agent']); return resp(200, { ok: true }); }
    if (b.action === 'unsubscribe') { await push.unsubscribe(String(b.endpoint || '')); return resp(200, { ok: true }); }
    const r = await push.sendAll({ title: 'Aviso de prueba', body: 'Si ves esto, este celular ya recibe los avisos de MAD BEER.', tag: 'test', url: '/#panel' });
    return resp(200, { ok: true, devices: r.devices, sent: r.sent, failed: r.failed, removed: r.removed });
  } catch (e) { return resp(502, { error: e.message || 'No se pudo completar' }); }
};

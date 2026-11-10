/* Prepara el pago con Wompi: calcula la firma de integridad en el servidor.
   Variables de entorno: WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_SECRET (y SITE_URL opcional). */
const crypto = require('crypto');
const fs = require('../lib/fs');
const { resp } = require('../lib/common');
const { check } = require('../lib/pricing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido' });
  const pub = process.env.WOMPI_PUBLIC_KEY, sec = process.env.WOMPI_INTEGRITY_SECRET;
  if (!pub || !sec) return resp(503, { error: 'El pago en línea todavía no está configurado.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Solicitud inválida' }); }
  const code = String(b.code || '').toUpperCase();
  if (!/^MB-[A-Z0-9]{6}$/.test(code)) return resp(400, { error: 'Código inválido' });
  try {
    const o = await fs.getDoc('orders', code);
    if (!o || o.pay !== 'wompi') return resp(404, { error: 'Pedido no encontrado' });
    if (o.payStatus === 'APPROVED') return resp(409, { error: 'Este pedido ya está pagado.' });
    if (o.status === 'Cancelado') return resp(409, { error: 'Este pedido fue cancelado.' });
    const pr = await check(o);   /* el total se vuelve a calcular aquí: no se le cree al navegador */
    if (!pr.ok) return resp(409, { error: pr.why + ' Vuelve a armar el pedido.' });
    const cents = Math.round(pr.total * 100);
    if (!(cents > 0)) return resp(400, { error: 'Valor inválido' });
    const reference = code + '_' + Date.now().toString(36);
    const signature = crypto.createHash('sha256').update(reference + cents + 'COP' + sec).digest('hex');
    const site = (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
    return resp(200, { publicKey: pub, currency: 'COP', amountInCents: cents, reference, signature, redirectUrl: site ? site + '/' : '' });
  } catch (e) { return resp(500, { error: e.message }); }
};

/* Cada 5 minutos: envía a Alegra las ventas que falten y trae el inventario, aunque nadie tenga el panel abierto.
   Solo corre en el sitio publicado (no en vistas previas). Para probarlo: Netlify > Functions > alegra-cron > Run now. */
import sync from '../lib/sync.js';
import push from '../lib/push.js';

export default async () => {
  try { const n = await push.sweepOrders(); if (n) console.log('alegra-cron avisos de pedidos', n); } catch (e) { console.log('alegra-cron avisos error', e && e.message); }
  try {
    const r = await sync.runSync({});
    console.log('alegra-cron', JSON.stringify({ ran: r.ran, sent: r.sent.length, skip: r.skip, error: r.error, productos: r.stock }));
  } catch (e) {
    console.log('alegra-cron error', e && e.message);
  }
};

export const config = { schedule: '*/5 * * * *' };

/* Cuánto vale de verdad un pedido, calculado en el servidor.
   La página arma el pedido y manda el total, pero un navegador manipulado podría mandar un total más bajo:
   por eso antes de cobrar o de dar por pagado un pedido se vuelve a calcular con los precios del catálogo. */
const fs = require('./fs');

/* Mismos valores de fábrica que la página, por si el negocio aún no ha guardado sus ajustes */
const DEF_ZONES = [{ id: 'z1', fee: 3000 }, { id: 'z2', fee: 5000 }, { id: 'z3', fee: 8000 }];
const DEF_FREE = 90000;

async function check(o) {
  if (!o || !Array.isArray(o.lines) || !o.lines.length || o.lines.length > 60) return { ok: false, why: 'El pedido no tiene productos válidos.' };
  const cat = (await fs.getDoc('config', 'catalog')) || {};
  const by = {}; (Array.isArray(cat.products) ? cat.products : []).forEach((p) => { by[p.id] = p; });
  let sub = 0;
  for (const l of o.lines) {
    const p = by[l.id], q = Number(l.qty);
    if (!p || !Number.isInteger(q) || q < 1 || q > 500 || Number(l.price) !== Number(p.price)) return { ok: false, why: 'Los precios del pedido no coinciden con los del catálogo.' };
    sub += q * Number(p.price);
  }
  const st = (await fs.getDoc('config', 'store')) || {};
  const zones = Array.isArray(st.zones) && st.zones.length ? st.zones : DEF_ZONES;
  const free = Number.isFinite(Number(st.freeFrom)) && st.freeFrom !== undefined && st.freeFrom !== null ? Number(st.freeFrom) : DEF_FREE;
  let fee;
  if (o.mode !== 'recoger' && st.delivery !== true) return { ok: false, why: 'Los domicilios están apagados en la tienda.' };
  if (o.mode === 'recoger') fee = 0;
  else { const z = zones.filter((x) => x.id === o.zone)[0]; if (!z) return { ok: false, why: 'La zona de entrega no existe.' }; fee = o.zone === 'z1' && sub >= free ? 0 : Number(z.fee) || 0; }
  const total = sub + fee;
  if (Number(o.sub) !== sub || Number(o.fee) !== fee || Number(o.total) !== total) return { ok: false, why: 'El total del pedido no coincide con el cálculo del servidor.', expected: total };
  return { ok: true, total, sub, fee };
}

module.exports = { check };

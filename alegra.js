/* Hablar con la API de Alegra (correo + token) y entender sus ítems. Lo usan alegra.js y sync.js */
const ALEGRA = 'https://api.alegra.com/api/v1';

function makeApi(email, token) {
  const auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
  return async function call(method, path, body) {
    const r = await fetch(ALEGRA + path, {
      method, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
    if (!r.ok) {
      const msg = r.status === 401 ? 'Alegra no aceptó el correo o el token. Revísalos.' : (j && (j.message || j.error)) || ('Alegra respondió con error ' + r.status);
      const err = new Error(msg); err.status = r.status; throw err;
    }
    return j;
  };
}

/* Lista de precios de VENTA de un ítem. Nunca una lista de compra o costo. Si el negocio fija una (opts.priceList = su número), se usa esa. */
function pickList(it, opts) {
  const lists = (Array.isArray(it.price) ? it.price : []).filter((x) => x && x.price != null && !isNaN(Number(x.price)));
  const bad = (x) => /compra|costo|cost|proveedor/i.test(String(x.name || ''));
  const want = opts && Number(opts.priceList) > 0 ? Number(opts.priceList) : 0;
  let hit = want ? lists.filter((x) => Number(x.idPriceList) === want)[0] : null;
  if (!hit) hit = lists.filter((x) => Number(x.idPriceList) === 1 && !bad(x))[0];
  if (!hit) hit = lists.filter((x) => /general|venta|p[uú]blico|detal/i.test(String(x.name || '')) && !bad(x))[0];
  if (!hit) hit = lists.filter((x) => !bad(x))[0];
  return hit || null;
}

/* IVA (y otros impuestos como el impoconsumo) del ítem, como fracción: 0.19 */
function taxRateOf(it) {
  const t = Array.isArray(it.tax) ? it.tax : (it.tax ? [it.tax] : []);
  const r = t.reduce((a, x) => a + (Number(x && x.percentage) || 0), 0) / 100;
  return r > 0 && r < 1 ? r : 0;
}

/* Un ítem de Alegra en el formato simple que usa la tienda.
   En Alegra el precio de la lista va SIN impuesto; la tienda muestra el precio final, así que se le suma el IVA.
   opts.priceTax = 'none' deja el precio tal cual. Si el precio no supera el costo de compra, se marca como sospechoso (suspect). */
function normItem(it, opts) {
  const lst = pickList(it, opts);
  const base = Array.isArray(it.price) ? (lst ? Number(lst.price) : 0) : Number(it.price) || 0;
  const inv = it.inventory || null;
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const rate = opts && opts.priceTax === 'none' ? 0 : taxRateOf(it);
  const cost = inv ? num(inv.unitCost) : null;
  let qty = null;
  if (inv) {
    /* Alegra puede traer la cantidad total o repartida por bodega: se prueba en ese orden */
    qty = num(inv.availableQuantity);
    if (qty == null) qty = num(inv.quantity);
    if (qty == null && Array.isArray(inv.warehouses) && inv.warehouses.length) {
      qty = inv.warehouses.reduce((a, w) => a + (num(w.availableQuantity != null ? w.availableQuantity : w.initialQuantity) || 0), 0);
    }
  }
  const c = it.itemCategory || it.category;
  const category = typeof c === 'string' ? c : (c && c.name) || '';
  const price = base > 0 ? Math.round(base * (1 + rate)) : 0;
  const suspect = !!(base > 0 && cost != null && cost > 0 && base <= cost);
  return { id: it.id, name: it.name || '', reference: it.reference || '', category, price, base, taxRate: rate, cost, listName: lst ? String(lst.name || '') : '', suspect, qty, inventariable: qty != null };
}

/* Todos los ítems activos, de 30 en 30 (el máximo que deja Alegra). Se detiene si pasa el tiempo. */
async function allItems(api, deadline, opts) {
  const all = [];
  for (let start = 0; start < 3000; start += 30) {
    if (deadline && Date.now() > deadline) { const e = new Error('Se acabó el tiempo trayendo el inventario'); e.partial = true; throw e; }
    const l = await api('GET', '/items?start=' + start + '&limit=30&status=active&mode=advanced');
    const arr = Array.isArray(l) ? l : (l && l.data) || [];
    arr.forEach((x) => all.push(normItem(x, opts)));
    if (arr.length < 30) break;
  }
  return all;
}

module.exports = { makeApi, normItem, allItems };

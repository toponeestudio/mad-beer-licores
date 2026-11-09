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

/* Un ítem de Alegra en el formato simple que usa la tienda */
function normItem(it) {
  /* El precio general es la lista 1 ("General"); si no está, se usa la primera */
  const lst = Array.isArray(it.price) ? (it.price.filter((x) => x && Number(x.idPriceList) === 1)[0] || it.price[0]) : null;
  const pr = Array.isArray(it.price) ? (lst && lst.price) : it.price;
  const inv = it.inventory || null;
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
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
  return { id: it.id, name: it.name || '', reference: it.reference || '', category, price: Number(pr) || 0, qty, inventariable: qty != null };
}

/* Todos los ítems activos, de 30 en 30 (el máximo que deja Alegra). Se detiene si pasa el tiempo. */
async function allItems(api, deadline) {
  const all = [];
  for (let start = 0; start < 3000; start += 30) {
    if (deadline && Date.now() > deadline) { const e = new Error('Se acabó el tiempo trayendo el inventario'); e.partial = true; throw e; }
    const l = await api('GET', '/items?start=' + start + '&limit=30&status=active&mode=advanced');
    const arr = Array.isArray(l) ? l : (l && l.data) || [];
    arr.forEach((x) => all.push(normItem(x)));
    if (arr.length < 30) break;
  }
  return all;
}

module.exports = { makeApi, normItem, allItems };

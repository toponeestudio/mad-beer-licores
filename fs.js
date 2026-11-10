/* Firestore desde el servidor, sin dependencias: usa la clave de servicio de Firebase.
   Variable de entorno: FIREBASE_SERVICE_ACCOUNT (el JSON completo). */
const crypto = require('crypto');

let cache = { token: '', exp: 0 };
function sa() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT en Netlify.');
  const j = JSON.parse(raw);
  j.private_key = String(j.private_key || '').replace(/\\n/g, '\n');
  return j;
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cache.token && cache.exp - 60 > now) return cache.token;
  const k = sa();
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(k.private_key);
  const jwt = head + '.' + body + '.' + b64u(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('No se pudo autenticar con Firebase (' + r.status + ').');
  cache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cache.token;
}

/* Conversión entre JSON normal y el formato de la API REST de Firestore */
function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  return { mapValue: { fields: toFields(v) } };
}
function toFields(o) { const f = {}; Object.keys(o).forEach((k) => { if (o[k] !== undefined) f[k] = toVal(o[k]); }); return f; }
function fromVal(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; Object.keys(f || {}).forEach((k) => { o[k] = fromVal(f[k]); }); return o; }

function base() { return 'https://firestore.googleapis.com/v1/projects/' + sa().project_id + '/databases/(default)/documents'; }

async function getDoc(col, id) {
  const t = await accessToken();
  const r = await fetch(base() + '/' + col + '/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Firestore ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return fromFields(j.fields || {});
}
/* Cambia solo los campos indicados (los demás quedan igual) */
async function patchDoc(col, id, data) {
  const t = await accessToken();
  const mask = Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = await fetch(base() + '/' + col + '/' + encodeURIComponent(id) + '?' + mask, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: toFields(data) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Firestore ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return true;
}

/* Crea un documento nuevo. Devuelve false si ya existía (sirve como candado para no hacer algo dos veces) */
async function createDoc(col, id, data) {
  const t = await accessToken();
  const r = await fetch(base() + '/' + col + '?documentId=' + encodeURIComponent(id), {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: toFields(data) })
  });
  if (r.status === 409) return false;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Firestore ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return true;
}
async function delDoc(col, id) {
  const t = await accessToken();
  const r = await fetch(base() + '/' + col + '/' + encodeURIComponent(id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok && r.status !== 404) throw new Error('Firestore ' + r.status);
  return true;
}
/* Documentos de una colección donde un campo es igual a un valor. Cada uno trae su id en _id */
async function whereEq(col, field, value, limit) {
  const t = await accessToken();
  const r = await fetch(base() + ':runQuery', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toVal(value) } }, limit: limit || 100 } })
  });
  const j = await r.json().catch(() => []);
  if (!r.ok) throw new Error('Firestore ' + r.status + ': ' + ((j[0] && j[0].error && j[0].error.message) || ''));
  return (Array.isArray(j) ? j : []).filter((x) => x.document).map((x) => Object.assign(fromFields(x.document.fields || {}), { _id: x.document.name.split('/').pop() }));
}
module.exports = { getDoc, patchDoc, createDoc, delDoc, whereEq, toFields, fromFields };

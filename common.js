/* Piezas compartidas: respuestas y verificación de que quien llama es el panel del negocio */
const ADMIN = (process.env.ADMIN_EMAIL || 'madbeerlicores@gmail.com').toLowerCase();
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDh6GvqbdQWIRkuuPmU5RZESWyk44bP4gA';

const resp = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

async function adminEmailOf(idToken) {
  if (!idToken) return '';
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => ({}));
  return ((j.users && j.users[0] && j.users[0].email) || '').toLowerCase();
}
async function isAdmin(idToken) { return (await adminEmailOf(idToken)) === ADMIN; }

module.exports = { resp, isAdmin, ADMIN };

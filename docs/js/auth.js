const USERS_URL = './data/users.json';
const STORAGE_KEY = 'lavapies_riega_identity_v1';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function sha256(text){
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export function normalizeAlias(alias){
  return alias.trim().normalize('NFKC').toLocaleLowerCase('es-ES');
}

export function validAlias(alias){
  return /^[A-Za-zÀ-ÿ0-9._-]{3,28}$/.test(alias.trim());
}

function randomChars(n){
  const values = new Uint32Array(n);
  crypto.getRandomValues(values);
  return [...values].map(v => ALPHABET[v % ALPHABET.length]).join('');
}

export function generateSecret(){
  const s = randomChars(16);
  return [0,4,8,12].map(i=>s.slice(i,i+4)).join('-');
}

export function generateRequestId(){
  return `rq_${Date.now().toString(36)}_${randomChars(8).toLowerCase()}`;
}

export async function loadUsers(){
  try{
    const r = await fetch(`${USERS_URL}?v=${Date.now()}`, {cache:'no-store'});
    if(!r.ok) return [];
    return await r.json();
  }catch{
    return [];
  }
}

export async function aliasExists(alias){
  const users = await loadUsers();
  const n = normalizeAlias(alias);
  return users.some(u => normalizeAlias(u.alias) === n);
}

function saveLocalIdentity(identity){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export async function createPendingIdentity(alias){
  alias = alias.trim();
  if(!validAlias(alias)) throw new Error('Usa entre 3 y 28 caracteres: letras, números, punto, guion o guion bajo.');
  if(await aliasExists(alias)) throw new Error('Ese alias ya existe. Prueba otro.');
  const secret = generateSecret();
  const secret_hash = await sha256(secret);
  return saveLocalIdentity({
    alias,
    normalized_alias: normalizeAlias(alias),
    secret_hash,
    secret,
    request_id: generateRequestId(),
    state: 'pending',
    created_at: new Date().toISOString()
  });
}

export function getLocalIdentity(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { return null; }
}

export function logout(){ localStorage.removeItem(STORAGE_KEY); }

// Sin servidor podemos saber al día siguiente qué ocurrió comparando la
// identidad local con users.json: mismo alias+mismo hash = aceptada;
// mismo alias+otro hash = otra persona obtuvo antes el alias.
export async function syncLocalIdentity(){
  const identity = getLocalIdentity();
  if(!identity) return null;
  const users = await loadUsers();
  const n = normalizeAlias(identity.alias);
  const published = users.find(u => normalizeAlias(u.alias) === n);
  if(!published) return identity;

  if(published.secret_hash === identity.secret_hash){
    return saveLocalIdentity({...identity, ...published, secret: identity.secret, state:'published', rejection_reason:null});
  }

  if(identity.state !== 'published'){
    return saveLocalIdentity({...identity, state:'rejected', rejection_reason:'alias_taken', rejected_at:new Date().toISOString()});
  }
  return identity;
}

export async function renameRejectedIdentity(newAlias){
  const identity = getLocalIdentity();
  if(!identity?.secret || !identity?.secret_hash) throw new Error('No encuentro el código de esta identidad en el navegador.');
  newAlias = newAlias.trim();
  if(!validAlias(newAlias)) throw new Error('Usa entre 3 y 28 caracteres: letras, números, punto, guion o guion bajo.');
  if(await aliasExists(newAlias)) throw new Error('Ese alias también está ocupado. Prueba otro.');
  return saveLocalIdentity({
    ...identity,
    id: undefined,
    alias:newAlias,
    normalized_alias:normalizeAlias(newAlias),
    request_id:generateRequestId(),
    state:'pending',
    rejection_reason:null,
    created_at:new Date().toISOString()
  });
}

export async function login(alias, secret){
  const users = await loadUsers();
  const n = normalizeAlias(alias);
  const normalizedSecret = secret.trim().toUpperCase();
  const hash = await sha256(normalizedSecret);
  const user = users.find(u => normalizeAlias(u.alias) === n && u.secret_hash === hash);
  if(!user) throw new Error('Alias o código incorrectos.');
  return saveLocalIdentity({...user, secret:normalizedSecret, state:'published'});
}

export function registrationPayload(identity){
  return {
    type:'identity_registration',
    submission_id:identity.request_id,
    alias:identity.alias,
    normalized_alias:identity.normalized_alias,
    secret_hash:identity.secret_hash,
    created_at:identity.created_at
  };
}

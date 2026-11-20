// Google Drive: Anmeldung über Google (nur Zugriff auf Dateien, die diese App selbst anlegt) und Upload je Kategorie.
const GSI = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LS = k => 'sc_drive_' + k;
const get = (k, d) => { try { const v = localStorage.getItem(LS(k)); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch {} };

export const driveCfg = {
  get clientId() { return get('clientId', (window.SCANNER_CONFIG || {}).googleClientId || ''); },
  set clientId(v) { set('clientId', v); },
  get root() { return get('root', 'Scanner'); },
  set root(v) { set('root', v); set('folders', {}); },
  get auto() { return get('auto', true); },
  set auto(v) { set('auto', v); },
};

export const driveConfigured = () => !!driveCfg.clientId;
export const hasToken = () => { const t = get('token', null); return !!(t && t.exp > Date.now() + 60000); };
export function signOut() {
  const t = get('token', null);
  set('token', null); set('folders', {});
  if (t && window.google && google.accounts) google.accounts.oauth2.revoke(t.v, () => {});
}

function loadGsi() {
  return new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement('script');
    s.src = GSI; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('Google-Anmeldung nicht erreichbar'));
    document.head.appendChild(s);
  });
}
// vorab laden, damit der Anmelde-Tipp direkt ein Popup öffnen darf
export function preload() { if (driveConfigured()) loadGsi().catch(() => {}); }

// muss direkt aus einem Tipp heraus aufgerufen werden (Popup)
export function signIn() {
  return new Promise((res, rej) => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) { loadGsi().then(() => rej(new Error('Bitte nochmal tippen'))).catch(rej); return; }
    const c = google.accounts.oauth2.initTokenClient({
      client_id: driveCfg.clientId, scope: SCOPE,
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        set('token', { v: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
        res();
      },
      error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Anmeldung abgebrochen' : 'Anmeldung fehlgeschlagen')),
    });
    c.requestAccessToken({ prompt: '' });
  });
}

async function api(url, opts = {}) {
  const t = get('token', null);
  if (!t) throw new Error('Nicht bei Google angemeldet');
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t.v } });
  if (r.status === 401) { set('token', null); throw new Error('Google-Anmeldung abgelaufen'); }
  if (!r.ok) throw new Error('Google Drive: ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

async function folder(name, parent) {
  const cache = get('folders', {});
  const key = (parent || 'root') + '/' + name;
  if (cache[key]) return cache[key];
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parent || 'root'}' in parents`;
  const found = await api('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q));
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const made = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent || 'root'] }),
    });
    id = made.id;
  }
  cache[key] = id; set('folders', cache);
  return id;
}

// lädt hoch bzw. ersetzt eine früher hochgeladene Datei; gibt { id, folder } zurück
export async function upload(pdf, name, category, prev) {
  const root = await folder(driveCfg.root);
  const dir = category ? await folder(category, root) : root;
  const meta = { name, mimeType: 'application/pdf' };
  const body = new FormData();
  let url, method = 'POST';
  if (prev && prev.id) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${prev.id}?uploadType=multipart&fields=id`;
    if (prev.folder && prev.folder !== dir) url += `&addParents=${dir}&removeParents=${prev.folder}`;
    method = 'PATCH';
  } else {
    url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
    meta.parents = [dir];
  }
  body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  body.append('file', pdf);
  try {
    const r = await api(url, { method, body });
    return { id: r.id, folder: dir };
  } catch (e) {
    if (prev && prev.id && /404/.test(e.message)) return upload(pdf, name, category, null); // in Drive gelöscht -> neu
    throw e;
  }
}

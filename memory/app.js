'use strict';
/* Luisen Memory: 4×5 Karten, 10 Paare, jede Runde neu aus dem Bilderfundus gemischt. */

const CFG = window.MEMORY_CONFIG || {};
const LIVE = !!(CFG.supabaseUrl && CFG.supabaseKey) && !/[?&]demo/.test(location.search);
const BUCKET = CFG.bucket || 'memory';
const PAIRS = 10;
const SRC_MAX = 1400, THUMB_MAX = 480;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d){ try{ const v = localStorage.getItem('mem_' + k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('mem_' + k, JSON.stringify(v)); }catch(e){} }
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= Datenhaltung ================= */
// Ein Bild: {id, src (URL groß), thumb (URL klein), w, h, cx, cy, sz}
// cx/cy = Mitte des Ausschnitts (0..1), sz = Kante des Quadrats als Anteil der kürzeren Seite.

const Live = {
  base: () => CFG.supabaseUrl.replace(/\/$/, ''),
  pub(path){ return this.base() + '/storage/v1/object/public/' + BUCKET + '/' + encodeURIComponent(path); },
  async req(path, body){
    let res;
    try{
      res = await fetch(this.base() + '/rest/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {apikey: CFG.supabaseKey, 'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined
      });
    }catch(e){ throw new Error('Keine Verbindung. Bist du online?'); }
    const txt = await res.text();
    if(!res.ok){
      let msg = txt; try{ msg = JSON.parse(txt).message || txt; }catch(e){}
      if(/memory_bilder|mem_|schema cache/i.test(msg) && !/PIN/.test(msg)) msg = 'Der Bilderfundus ist in Supabase noch nicht eingerichtet (memory.sql ausführen).';
      throw new Error(msg);
    }
    return txt ? JSON.parse(txt) : null;
  },
  async list(){
    const rows = await this.req('memory_bilder?select=*&order=created_at.asc');
    const list = rows.map(r => ({id: r.id, src: this.pub(r.path), thumb: this.pub(r.thumb), w: r.w, h: r.h, cx: r.cx, cy: r.cy, sz: r.sz}));
    store.set('cache', list);
    return list;
  },
  async checkPin(pin){ return !!(await this.req('rpc/mem_check', {p_pin: pin})); },
  async upload(path, blob){
    let res;
    try{
      res = await fetch(this.base() + '/storage/v1/object/' + BUCKET + '/' + path, {
        method: 'POST', body: blob,
        headers: {apikey: CFG.supabaseKey, 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000'}
      });
    }catch(e){ throw new Error('Upload fehlgeschlagen. Bist du online?'); }
    if(!res.ok){ const t = await res.text(); let m = t; try{ m = JSON.parse(t).message || t; }catch(e){} throw new Error('Upload fehlgeschlagen: ' + m); }
  },
  async add(p, pin){
    const id = await this.req('rpc/mem_start', {p_pin: pin});
    await this.upload(id + '_t.jpg', p.thumb);
    await this.upload(id + '.jpg', p.src);
    await this.req('rpc/mem_save', {p_pin: pin, p_id: id, p_w: p.w, p_h: p.h, p_cx: p.cx, p_cy: p.cy, p_sz: p.sz});
  },
  async focus(id, f, pin){ await this.req('rpc/mem_focus', {p_pin: pin, p_id: id, p_cx: f.cx, p_cy: f.cy, p_sz: f.sz}); },
  async remove(id, pin){
    const paths = await this.req('rpc/mem_delete', {p_pin: pin, p_id: id});
    if(paths && paths.length) await fetch(this.base() + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE', headers: {apikey: CFG.supabaseKey, 'Content-Type': 'application/json'}, body: JSON.stringify({prefixes: paths})
    }).catch(() => {});
  }
};

// Demo: Bilder nur in diesem Browser (IndexedDB). PIN: luise
const Demo = {
  _db: null, _urls: {},
  db(){
    if(this._db) return this._db;
    return this._db = new Promise((res, rej) => {
      const r = indexedDB.open('luises-memory-demo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('bilder', {keyPath: 'id'});
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn){
    const db = await this.db();
    return new Promise((res, rej) => {
      const t = db.transaction('bilder', mode), s = t.objectStore('bilder');
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
    });
  },
  url(id, kind, blob){ const k = id + kind; return this._urls[k] ||= URL.createObjectURL(blob); },
  async list(){
    const rows = await this.tx('readonly', s => s.getAll());
    return rows.sort((a, b) => a.created - b.created).map(r => ({id: r.id, src: this.url(r.id, 's', r.src), thumb: this.url(r.id, 't', r.thumb), w: r.w, h: r.h, cx: r.cx, cy: r.cy, sz: r.sz}));
  },
  async checkPin(pin){ return String(pin).trim().toLowerCase() === 'luise'; },
  async add(p){ const id = Math.random().toString(36).slice(2, 12); await this.tx('readwrite', s => s.put({...p, id, created: Date.now()})); },
  async focus(id, f){ const r = await this.tx('readonly', s => s.get(id)); if(r) await this.tx('readwrite', s => s.put({...r, ...f})); },
  async remove(id){ await this.tx('readwrite', s => s.delete(id)); }
};
const API = LIVE ? Live : Demo;

/* ================= Platzhalter ================= */
const PH_EMOJI = ['🐶','🐱','🦊','🐼','🐨','🦁','🐸','🐵','🦄','🐝','🐢','🐙','🦋','🐞','🐳','🦉','🍓','🍉','🍒','🍋','🥨','🍦','🧁','🍕','🌻','🌈','⭐️','🌙','⚽️','🎈','🚂','🚀','🎸','🧸','🏰','🚲','⛵️','🎁','🦒','🐘'];
const PH_COL = ['#f7d9c4','#cde6d0','#d6e4f5','#f6e3a7','#e9d3ef','#f5c9c9','#c9eee8','#e2e8c3'];
let PH = null;
function placeholders(){
  if(PH) return PH;
  PH = PH_EMOJI.map((e, i) => {
    const c = document.createElement('canvas'); c.width = c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = PH_COL[i % PH_COL.length]; g.fillRect(0, 0, 240, 240);
    g.font = '150px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, 120, 132);
    const u = c.toDataURL('image/png');
    return {id: 'ph' + i, src: u, thumb: u, w: 240, h: 240, cx: .5, cy: .5, sz: 1, ph: true};
  });
  return PH;
}

/* ================= Zuschnitt ================= */
// CSS-Hintergrund, der genau den quadratischen Ausschnitt zeigt (funktioniert in jeder Kachelgröße).
function cropStyle(b, url){
  const short = Math.min(b.w, b.h), s = clamp(b.sz || 1, .2, 1) * short;
  const px = b.w - s < 1 ? 50 : clamp((b.cx * b.w - s / 2) / (b.w - s), 0, 1) * 100;
  const py = b.h - s < 1 ? 50 : clamp((b.cy * b.h - s / 2) / (b.h - s), 0, 1) * 100;
  return `background-image:url("${url}");background-size:${(b.w / s * 100).toFixed(2)}% auto;background-position:${px.toFixed(2)}% ${py.toFixed(2)}%`;
}

// Automatischer Ausschnitt: sucht Hautflächen (Gesichter, Personen), sonst das kontrastreichste Motiv.
function autoFocus(img, W, H){
  const N = 128, k = N / Math.max(W, H), w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, n = w * h;
  const Y = new Float32Array(n), skin = new Float32Array(n);
  let mr = 0, mg = 0, mb = 0;
  for(let i = 0; i < n; i++){
    const r = d[i*4], gg = d[i*4+1], b = d[i*4+2];
    mr += r; mg += gg; mb += b;
    const y = .299*r + .587*gg + .114*b, cb = 128 - .1687*r - .3313*gg + .5*b, cr = 128 + .5*r - .4187*gg - .0813*b;
    Y[i] = y;
    skin[i] = (cr > 136 && cr < 173 && cb > 80 && cb < 127 && y > 60 && y < 245 && r > gg && r > b && r - Math.min(gg, b) > 18) ? 1 : 0;
  }
  mr /= n; mg /= n; mb /= n;
  // Hautmaske glätten (nur zusammenhängende Flächen zählen)
  const sk = new Float32Array(n), R = 1;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    let s = 0, m = 0;
    for(let dy = -R; dy <= R; dy++) for(let dx = -R; dx <= R; dx++){
      const xx = x + dx, yy = y + dy; if(xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += skin[yy*w + xx]; m++;
    }
    sk[y*w + x] = s / m > .6 ? 1 : 0;
  }
  const E = new Float32Array(n);
  let skinN = 0, emax = 0;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    const i = y*w + x;
    const gx = x > 0 && x < w-1 ? Math.abs(Y[i+1] - Y[i-1]) : 0, gy = y > 0 && y < h-1 ? Math.abs(Y[i+w] - Y[i-w]) : 0;
    const dist = Math.hypot(d[i*4] - mr, d[i*4+1] - mg, d[i*4+2] - mb);
    const nx = x / w - .5, ny = y / h - .45;
    const prior = .45 + .55 * Math.exp(-(nx*nx + ny*ny) / (2 * .3 * .3));
    E[i] = (gx + gy + dist * .6) * prior;
    if(E[i] > emax) emax = E[i];
    skinN += sk[i];
  }
  // Hautflächen zu Gruppen zusammenfassen: nur die größte und ähnlich große (mehrere Personen) zählen,
  // einzelne Flecken in Holz, Sand oder Hintergrund werden ignoriert.
  if(skinN){
    const lab = new Int32Array(n), sizes = [0]; let L = 0;
    for(let i = 0; i < n; i++){
      if(!sk[i] || lab[i]) continue;
      L++; let cnt = 0; const st = [i]; lab[i] = L;
      while(st.length){
        const j = st.pop(), x = j % w; cnt++;
        for(const k of [j - w, j + w, x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1])
          if(k >= 0 && k < n && sk[k] && !lab[k]){ lab[k] = L; st.push(k); }
      }
      sizes.push(cnt);
    }
    const big = Math.max(...sizes);
    skinN = 0;
    for(let i = 0; i < n; i++){ if(sk[i] && sizes[lab[i]] < Math.max(8, big * .35)) sk[i] = 0; skinN += sk[i]; }
  }
  const useSkin = skinN >= Math.max(12, n * .0015) && skinN < n * .4;
  const wt = new Float32Array(n);
  for(let i = 0; i < n; i++){ const e = E[i] / (emax || 1); wt[i] = useSkin ? sk[i] * (.3 + e) : e * e; }
  // gewichtete Perzentile in x und y
  const px = new Float32Array(w), py = new Float32Array(h); let tot = 0;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){ const v = wt[y*w + x]; px[x] += v; py[y] += v; tot += v; }
  const pct = (arr, p) => { let a = 0; const t = tot * p; for(let i = 0; i < arr.length; i++){ a += arr[i]; if(a >= t) return i + .5; } return arr.length - .5; };
  const lo = useSkin ? .04 : .12, hi = 1 - lo;
  let x0 = pct(px, lo), x1 = pct(px, hi), y0 = pct(py, lo), y1 = pct(py, hi);
  if(!tot){ x0 = 0; x1 = w; y0 = 0; y1 = h; }
  const short = Math.min(w, h);
  let size = Math.max(x1 - x0, y1 - y0) * (useSkin ? 1.45 : 1.12) + short * .06;
  size = clamp(size, short * .42, short);
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if(useSkin) cy += (y1 - y0) * .08;   // etwas Platz unter den Gesichtern
  cx = clamp(cx, size / 2, w - size / 2); cy = clamp(cy, size / 2, h - size / 2);
  return {cx: +(cx / w).toFixed(4), cy: +(cy / h).toFixed(4), sz: +(size / short).toFixed(4)};
}

const canvasBlob = (c, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Bild konnte nicht verarbeitet werden.')), 'image/jpeg', q));
function loadImage(src, cors){
  return new Promise((res, rej) => {
    const isBlob = src instanceof Blob, url = isBlob ? URL.createObjectURL(src) : src, img = new Image();
    if(cors) img.crossOrigin = 'anonymous';
    img.onload = () => { if(isBlob) URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { if(isBlob) URL.revokeObjectURL(url); rej(new Error('Dieses Bild kann nicht gelesen werden.')); };
    img.src = url;
  });
}
function scaled(img, max){
  const W = img.naturalWidth, H = img.naturalHeight, k = Math.min(1, max / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function prepare(file){
  const img = await loadImage(file);
  const big = scaled(img, SRC_MAX), small = scaled(img, THUMB_MAX);
  const f = autoFocus(small, small.width, small.height);
  return {src: await canvasBlob(big, .85), thumb: await canvasBlob(small, .8), w: big.width, h: big.height, ...f};
}

/* ================= Spiel ================= */
let BILDER = [];          // eigener Fundus
let G = null;             // laufendes Spiel

/* ---------- Weihnachts-Motive ---------- */
const XMAS = [['🎄','#1f6b45'],['🎁','#f3e3c3'],['🎅','#2c5d8f'],['⛄️','#2f4f7f'],['🦌','#e7d3b0'],['🔔','#1f6b45'],['⭐️','#1d2b55'],['🕯️','#5a2333'],
  ['🍪','#cfe5f2'],['🧦','#f1e6cf'],['🛷','#cde4ef'],['❄️','#244a78'],['🎀','#e8f1e4'],['🍭','#fbe7c6'],['👼','#c9ddf0'],['🧣','#efe2c8'],['🧤','#d7e8d0'],['🍊','#22573c'],['🌰','#f4e6cf'],['🏠','#1b2c4f']];
let XM = null;
function xmasTiles(){
  if(XM) return XM;
  XM = XMAS.map(([e, col], i) => {
    const c = document.createElement('canvas'); c.width = c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = col; g.fillRect(0, 0, 300, 300);
    // ein paar Schneeflocken-Punkte
    g.fillStyle = 'rgba(255,255,255,.35)';
    for(let k = 0; k < 26; k++){ const x = (k * 97 + i * 31) % 300, y = (k * 53 + i * 71) % 300; g.beginPath(); g.arc(x, y, 2 + (k % 3), 0, 7); g.fill(); }
    g.font = '200px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, 150, 166);
    const u = c.toDataURL('image/png');
    return {id: 'xm' + i, src: u, thumb: u, w: 300, h: 300, cx: .5, cy: .5, sz: 1};
  });
  return XM;
}

let MODE = 'foto';
function pickRound(){
  if(MODE === 'xmas'){
    const hist = store.get('hist', {});
    return xmasTiles().slice().sort((a, b) => ((hist[a.id] ?? -1) + Math.random() * .9) - ((hist[b.id] ?? -1) + Math.random() * .9)).slice(0, PAIRS);
  }
  const own = BILDER.slice();
  const hist = store.get('hist', {});
  // am längsten nicht gezeigte Bilder zuerst, innerhalb gleicher Runde zufällig
  own.sort((a, b) => ((hist[a.id] ?? -1) + Math.random() * .9) - ((hist[b.id] ?? -1) + Math.random() * .9));
  let pick = own.slice(0, PAIRS);
  if(pick.length < PAIRS){
    const ph = placeholders().slice().sort((a, b) => ((hist[a.id] ?? -1) + Math.random() * .9) - ((hist[b.id] ?? -1) + Math.random() * .9));
    pick = pick.concat(ph.slice(0, PAIRS - pick.length));
  }
  return pick;
}

function newGame(){
  // Rundenzähler: beginnt jeden Tag bei 1; ein ungespieltes Spiel (z. B. App neu geöffnet) zählt nicht.
  const today = new Date().toDateString(), r = store.get('rnd', {day: '', n: 0, used: false});
  const round = r.day !== today ? 1 : r.used ? r.n + 1 : Math.max(1, r.n);
  store.set('rnd', {day: today, n: round, used: false});
  const pick = pickRound();
  const hist = store.get('hist', {}); pick.forEach(b => hist[b.id] = round); store.set('hist', hist);
  pick.forEach(b => { const i = new Image(); i.src = b.src; });   // vorladen
  const deck = pick.flatMap(b => [b, b]);
  for(let i = deck.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  G = {round, deck, open: [], done: new Set(), tries: 0, pairs: 0, timer: null, finished: false};
  renderBoard();
}

function renderBoard(){
  $('#roundLabel').textContent = 'Runde ' + G.round;
  $('#board').innerHTML = G.deck.map((b, i) =>
    `<button class="card" data-i="${i}" aria-label="Karte ${i + 1}"><div class="inner"><div class="face back"><b>Luise</b></div><div class="face front" style='${cropStyle(b, b.src)}'></div></div></button>`).join('');
  updateScore();
}
function updateScore(){
  $('#tries').textContent = G.tries;
  $('#pairs').textContent = G.pairs + ' / ' + PAIRS;
}
const cardEl = i => $('#board').children[i];

function closeOpen(){
  clearTimeout(G.timer); G.timer = null;
  G.open.forEach(i => cardEl(i).classList.remove('open', 'miss'));
  G.open = [];
}
function tap(i){
  if(!G || G.finished || G.done.has(i) || G.open.includes(i)) return;
  if(G.open.length === 2) closeOpen();          // nach Fehlversuch sofort weiterspielen
  if(!G.tries && !G.open.length) store.set('rnd', {...store.get('rnd', {}), used: true});
  G.open.push(i); cardEl(i).classList.add('open');
  if(G.open.length < 2) return;
  G.tries++;
  const [a, b] = G.open;
  if(G.deck[a].id === G.deck[b].id){
    G.done.add(a); G.done.add(b); G.pairs++; G.open = [];
    [a, b].forEach(k => { const el = cardEl(k); el.classList.remove('open'); el.classList.add('done', 'pop'); });
    setTimeout(() => [a, b].forEach(k => cardEl(k)?.classList.add('gone')), 900);   // gefundenes Paar ausblenden, Lücke bleibt
    if(navigator.vibrate) navigator.vibrate(15);
    if(G.pairs === PAIRS){ G.finished = true; setTimeout(win, 750); }
  } else {
    setTimeout(() => G.open.length === 2 && G.open.forEach(k => cardEl(k).classList.add('miss')), 430);
    G.timer = setTimeout(closeOpen, 1300);
  }
  updateScore();
}

function win(){
  const st = store.get('stats', {played: 0, sum: 0, best: null});
  const isBest = st.best == null || G.tries < st.best;
  st.played++; st.sum += G.tries; if(isBest) st.best = G.tries; store.set('stats', st);
  const lob = G.tries <= 13 ? 'Wahnsinn!' : G.tries <= 17 ? 'Super gemacht!' : G.tries <= 22 ? 'Geschafft!' : 'Alle gefunden!';
  modal(`<div class="dialog"><h2>${lob}</h2><p>Alle 10 Paare gefunden in</p><div class="big">${G.tries}</div><p>Versuchen${isBest && st.played > 1 ? ' · neuer Rekord!' : ''}</p>
    <div class="row"><button class="pill primary" data-act="next">Nächste Runde</button></div></div>`);
}
function renderParentStats(){
  const st = store.get('stats', {played: 0, sum: 0, best: null}), r = store.get('rnd', {n: 0});
  $('#pstats').innerHTML = `<div class="grid">
      <div><b>${st.played}</b><small>Runden</small></div>
      <div><b>${st.best ?? '–'}</b><small>Bestwert</small></div>
      <div><b>${st.played ? (st.sum / st.played).toFixed(1) : '–'}</b><small>Schnitt</small></div>
      <div><b>${r.n || 0}</b><small>Runde heute</small></div></div>
    <div class="acts"><button data-p="resetRound">Rundenzähler auf 1</button><button data-p="resetStats">Statistik löschen</button></div>`;
}
$('#pstats').addEventListener('click', e => {
  const a = e.target.closest('[data-p]')?.dataset.p;
  if(a === 'resetRound'){ store.set('rnd', {day: new Date().toDateString(), n: 0, used: true}); NEED_NEW = true; }
  if(a === 'resetStats') store.set('stats', {played: 0, sum: 0, best: null});
  renderParentStats();
});

/* ================= Modal ================= */
function modal(html){ $('#modal').innerHTML = html ? `<div class="overlay">${html}</div>` : ''; }
$('#modal').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if(e.target.classList.contains('overlay') && !G?.finished) return modal('');
  if(act === 'close') modal('');
  if(act === 'next'){ modal(''); newGame(); }
});

let SESSION_PIN = '';
function askPin(){
  if(SESSION_PIN) return Promise.resolve(SESSION_PIN);
  return new Promise(resolve => {
    modal(`<div class="dialog"><h2>Elternbereich</h2><p>Bitte die Memory-PIN eingeben.${LIVE ? '' : ' (Demo: luise)'}</p>
      <input id="pinIn" type="password" autocomplete="off" autocapitalize="off" enterkeyhint="done"><div class="err" id="pinErr"></div>
      <div class="row"><button class="pill" id="pinNo">Abbrechen</button><button class="pill primary" id="pinOk">OK</button></div></div>`);
    const inp = $('#pinIn'); setTimeout(() => inp.focus(), 50);
    const ok = async () => {
      const p = inp.value.trim(); if(!p) return;
      try{
        if(await API.checkPin(p)){ SESSION_PIN = p; modal(''); resolve(p); }
        else { $('#pinErr').textContent = 'Falsche PIN'; inp.select(); }
      }catch(e){ $('#pinErr').textContent = e.message; }
    };
    $('#pinOk').onclick = ok; inp.onkeydown = e => { if(e.key === 'Enter') ok(); };
    $('#pinNo').onclick = () => { modal(''); resolve(null); };
  });
}
function pinFailed(e){ if(/PIN/.test(e.message)) SESSION_PIN = ''; }

/* ================= Fundus ================= */
function renderFundus(){
  $('#fcount').textContent = BILDER.length === 1 ? '1 Bild' : BILDER.length + ' Bilder' + (BILDER.length < 50 ? ' · Ziel: 50 bis 100' : '');
  $('#thumbs').innerHTML = BILDER.slice().reverse().map(b => `<button class="thumb" data-id="${esc(b.id)}" style='${cropStyle(b, b.thumb)}' aria-label="Bild bearbeiten"></button>`).join('');
}
let NEED_NEW = false;
async function openFundus(){
  if(!(await askPin())) return;
  $('#fundus').classList.remove('hidden');
  renderFundus(); renderParentStats();
  try{ BILDER = await API.list(); renderFundus(); }catch(e){ $('#fnote').textContent = e.message; }
}
$('#fileIn').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if(!files.length) return;
  const pin = SESSION_PIN; if(!pin) return;
  const box = $('#upProg'), bar = $('#upBar'), txt = $('#upText');
  box.classList.remove('hidden'); $('#addLabel').classList.add('hidden');
  let ok = 0, fail = 0, lastErr = '';
  for(let i = 0; i < files.length; i++){
    txt.textContent = `Bild ${i + 1} von ${files.length} wird zugeschnitten und hochgeladen …`;
    bar.style.width = (i / files.length * 100) + '%';
    try{ await API.add(await prepare(files[i]), pin); ok++; }
    catch(err){ fail++; lastErr = err.message; pinFailed(err); if(/PIN|eingerichtet|Maximal/.test(err.message)) break; }
  }
  bar.style.width = '100%';
  try{ BILDER = await API.list(); }catch(e){}
  renderFundus();
  txt.textContent = `${ok} ${ok === 1 ? 'Bild' : 'Bilder'} hinzugefügt` + (fail ? `, ${fail} fehlgeschlagen (${lastErr})` : '.');
  $('#addLabel').classList.remove('hidden');
  setTimeout(() => { if(!fail) box.classList.add('hidden'); }, 3500);
});
$('#thumbs').addEventListener('click', e => {
  const id = e.target.closest('.thumb')?.dataset.id; if(!id) return;
  const b = BILDER.find(x => x.id === id); if(b) openCrop(b);
});

/* ---------- Ausschnitt anpassen ---------- */
async function openCrop(b){
  const pin = SESSION_PIN; if(!pin) return;
  modal(`<div class="dialog" id="crop"><h2>Ausschnitt</h2><p>Verschieben mit dem Finger, zoomen mit zwei Fingern oder dem Regler.</p>
    <div class="cropbox" id="cbox"><canvas id="ccan"></canvas></div>
    <input type="range" class="zoom" id="czoom" min="1" max="3" step="0.01">
    <div class="err" id="cerr"></div>
    <div class="row"><button class="pill" data-c="auto">Automatisch</button><button class="pill primary" data-c="save">Fertig</button></div>
    <button class="linkish danger" data-c="del">Bild aus dem Fundus löschen</button> &nbsp; <button class="linkish" data-c="cancel">Abbrechen</button></div>`);
  const can = $('#ccan'), box = $('#cbox'), zoom = $('#czoom');
  let img; try{ img = await loadImage(b.src, LIVE); }catch(e){ $('#cerr').textContent = e.message; }
  const f = {cx: b.cx, cy: b.cy, sz: b.sz};
  const short = Math.min(b.w, b.h);
  const fix = () => {
    f.sz = clamp(f.sz, 1 / 3, 1);
    const s = f.sz * short;
    f.cx = clamp(f.cx, s / 2 / b.w, 1 - s / 2 / b.w); f.cy = clamp(f.cy, s / 2 / b.h, 1 - s / 2 / b.h);
  };
  const draw = () => {
    fix(); zoom.value = 1 / f.sz;
    const V = box.clientWidth * devicePixelRatio; can.width = can.height = V;
    if(!img) return;
    const s = f.sz * short, sx = f.cx * b.w - s / 2, sy = f.cy * b.h - s / 2, k = img.naturalWidth / b.w;
    can.getContext('2d').drawImage(img, sx * k, sy * k, s * k, s * k, 0, 0, V, V);
  };
  draw();
  zoom.oninput = () => { f.sz = 1 / zoom.value; draw(); };
  const pts = new Map(); let last = null;
  box.onpointerdown = e => { box.setPointerCapture(e.pointerId); pts.set(e.pointerId, {x: e.clientX, y: e.clientY}); last = null; };
  box.onpointerup = box.onpointercancel = e => { pts.delete(e.pointerId); last = null; };
  box.onpointermove = e => {
    if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    const p = [...pts.values()], V = box.clientWidth;
    const cur = p.length >= 2 ? {x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)} : {x: p[0].x, y: p[0].y, d: 0};
    if(last && last.n === p.length){
      const s = f.sz * short;
      f.cx -= (cur.x - last.x) * s / V / b.w; f.cy -= (cur.y - last.y) * s / V / b.h;
      if(cur.d && last.d) f.sz *= last.d / cur.d;
      draw();
    }
    last = {...cur, n: p.length};
  };
  $('#crop').onclick = async e => {
    const c = e.target.closest('[data-c]')?.dataset.c; if(!c) return;
    try{
      if(c === 'cancel') return modal('');
      if(c === 'auto'){ if(img) Object.assign(f, autoFocus(img, b.w, b.h)); draw(); return; }
      if(c === 'save'){ await API.focus(b.id, {cx: f.cx, cy: f.cy, sz: f.sz}, pin); Object.assign(b, f); }
      if(c === 'del'){
        if(!$('#crop').dataset.sure){ $('#crop').dataset.sure = 1; e.target.textContent = 'Wirklich löschen? Nochmal tippen.'; return; }
        await API.remove(b.id, pin); BILDER = BILDER.filter(x => x.id !== b.id);
      }
      modal(''); renderFundus();
    }catch(err){ pinFailed(err); $('#cerr').textContent = err.message; }
  };
}

/* ================= Start ================= */
$('#board').addEventListener('click', e => { const c = e.target.closest('.card'); if(c) tap(+c.dataset.i); });
$('#btnNew').onclick = newGame;
// Elternbereich: Titel 2 Sekunden gedrückt halten, dann PIN.
(() => {
  let t = null;
  const stop = () => { clearTimeout(t); t = null; };
  document.querySelectorAll('h1').forEach(h => {
    h.addEventListener('pointerdown', () => { stop(); t = setTimeout(() => { stop(); openFundus(); }, 2000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => h.addEventListener(ev, stop));
    h.addEventListener('contextmenu', e => e.preventDefault());
  });
})();
$('#btnBack').onclick = () => {
  $('#fundus').classList.add('hidden'); SESSION_PIN = '';
  if(!$('#start').classList.contains('hidden')){ renderCollage(); NEED_NEW = false; return; }
  if(NEED_NEW || !G || !G.tries || G.finished) newGame();
  NEED_NEW = false;
};

/* ---------- Startauswahl ---------- */
function renderCollage(){
  const src = (BILDER.length ? BILDER : placeholders()).slice().sort(() => Math.random() - .5).slice(0, 4);
  $('#collage').innerHTML = src.map(b => `<i style='${cropStyle(b, b.thumb)}'></i>`).join('');
}
function showStart(){
  $('#game').classList.add('hidden'); $('#start').classList.remove('hidden');
  document.body.classList.remove('xmas'); modal(''); renderCollage();
}
function play(mode){
  MODE = mode; store.set('mode', mode);
  document.body.classList.toggle('xmas', mode === 'xmas');
  $('#start').classList.add('hidden'); $('#game').classList.remove('hidden');
  newGame();
}
$('#start').addEventListener('click', e => { const m = e.target.closest('[data-mode]')?.dataset.mode; if(m) play(m); });
$('#btnHome').onclick = showStart;

(async function start(){
  if(LIVE) BILDER = store.get('cache', []);
  renderCollage();
  try{ BILDER = await API.list(); renderCollage(); }catch(e){ console.warn(e); }
  if('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

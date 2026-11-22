import { loadImage, detectQuad, warp, rotate, applyFilter, canvasToBlob, makeCanvas, extractSignature, alphaToSignature, FILTERS, orderQuad } from './imgproc.js';
import { recognize, analyse, buildName, todayIso, findSignatureSpots, placeSignature, boxFor } from './ocr.js';
import { buildPdf } from './pdf.js';
import * as db from './db.js';
import { loadPdfPages, stampPdf } from './pdfin.js';
import * as drive from './drive.js';
import { getCats, setCats, resetCats, suggestCategory, learn } from './cats.js';

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Einstellungen ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('sc_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sc_' + k, JSON.stringify(v)); } catch { toast('Einstellung konnte nicht gespeichert werden'); } },
};
const cfg = {
  get sig() { return store.get('sig', null); },          // { url, aspect }
  get color() { return store.get('color', '#14286e'); },
  get city() { return store.get('city', ''); },
  get prefer() { return store.get('prefer', ''); },
  get autoDate() { return store.get('autoDate', true); },
  get filter() { return store.get('filter', 'magic'); },
};

// ---------- kleine UI-Helfer ----------
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(text, frac) {
  const b = $('#busy');
  if (text === false) return b.classList.add('hidden');
  b.classList.remove('hidden'); $('#busyText').textContent = text;
  $('#busyBar').classList.toggle('hidden', frac == null);
  if (frac != null) $('#busyBar i').style.width = Math.round(frac * 100) + '%';
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
function menu(items) {
  return new Promise(res => {
    const box = $('#menuBox'); box.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.innerHTML = (it.icon ? `<svg class="i"><use href="#${it.icon}"/></svg>` : '') + it.label;
      b.onclick = e => { e.stopPropagation(); close(it.run ? it.run() : it.value); }; // run: direkt im Tipp (für Dateiauswahl/Zwischenablage)
      box.appendChild(b);
    }
    const c = document.createElement('button'); c.className = 'cancel'; c.textContent = 'Abbrechen'; c.onclick = () => close(null); box.appendChild(c);
    const m = $('#menu'); m.classList.remove('hidden');
    m.onclick = e => { if (e.target === m) close(null); };
    function close(v) { m.classList.add('hidden'); res(v); }
  });
}
function show(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== id);
  current = id;
}
let current = 'home';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Datei-Auswahl als Promise (Kamera / Fotos)
function pickFiles(input) {
  return new Promise(res => {
    input.value = '';
    input.onchange = () => res([...input.files]);
    input.click();
  });
}

// ---------- Dokument im Speicher ----------
let doc = null;   // { id, created, fields, pages: [...] , isNew }
let cur = 0;
let dirty = false;

function newDoc() {
  return { id: uid(), created: Date.now(), fields: null, pages: [], isNew: true };
}

// Bild-Caches (nur die zuletzt benutzte Seite, damit das Handy nicht volläuft)
const srcCache = { id: null, canvas: null };
const warpCache = { key: null, canvas: null };
async function srcCanvas(p) {
  if (srcCache.id === p.id) return srcCache.canvas;
  const c = await loadImage(p.src, 99999);
  srcCache.id = p.id; srcCache.canvas = c;
  return c;
}

async function renderPage(p) {
  const key = p.id + JSON.stringify(p.quad);
  let w = warpCache.key === key ? warpCache.canvas : null;
  if (!w) {
    const s = await srcCanvas(p);
    w = warp(s, p.quad);
    warpCache.key = key; warpCache.canvas = w;
  }
  const out = applyFilter(rotate(w, p.rot), p.filter);
  p.view = await canvasToBlob(out, 'image/jpeg', 0.9);
  p.vw = out.width; p.vh = out.height;
  setUrl(p);
  p.ocr = null;
}
function setUrl(p) {
  if (p.url) URL.revokeObjectURL(p.url);
  p.url = URL.createObjectURL(p.view);
}

// ---------- Startseite ----------
let docsCache = [];
async function refreshList() {
  try { docsCache = await db.allDocs(); } catch (e) { docsCache = []; toast('Speicher nicht verfügbar: ' + e.message); }
  docsCache.sort((a, b) => b.updated - a.updated);
  if (catFilter && !docsCache.some(d => d.category === catFilter)) catFilter = '';
  renderCatbar();
  renderList();
  const pend = drive.driveConfigured() ? docsCache.filter(d => d.drivePending).length : 0;
  const bn = $('#syncBanner');
  bn.classList.toggle('hidden', !pend);
  bn.textContent = `☁︎ ${pend} ${pend === 1 ? 'Dokument wartet' : 'Dokumente warten'} auf Google Drive – jetzt hochladen`;
}
let catFilter = '';
function renderCatbar() {
  const bar = $('#catbar');
  const used = [...new Set(docsCache.map(d => d.category).filter(Boolean))];
  bar.classList.toggle('hidden', used.length < 2);
  bar.innerHTML = '';
  for (const c of ['', ...getCats().map(c => c.name).filter(n => used.includes(n))]) {
    const b = document.createElement('button');
    b.textContent = c || 'Alle'; b.className = c === catFilter ? 'on' : '';
    b.onclick = () => { catFilter = c; renderCatbar(); renderList(); };
    bar.appendChild(b);
  }
}
function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const list = $('#list');
  list.innerHTML = '';
  for (const u of list._urls || []) URL.revokeObjectURL(u);
  list._urls = [];
  const items = docsCache.filter(d => (!catFilter || d.category === catFilter)).filter(d => !q || d.name.toLowerCase().includes(q) || (d.text || '').toLowerCase().includes(q));
  if (!docsCache.length) {
    list.innerHTML = `<div class="empty"><b>Noch keine Dokumente</b>Tippe auf „Scannen“, fotografiere ein Blatt und die App schneidet es automatisch zu.</div>`;
    return;
  }
  if (!items.length) { list.innerHTML = `<div class="empty">Nichts gefunden für „${esc(q)}“.</div>`; return; }
  for (const d of items) {
    const el = document.createElement('div');
    el.className = 'doc';
    const url = d.thumb ? URL.createObjectURL(d.thumb) : '';
    if (url) list._urls.push(url);
    let hit = '';
    if (q && !d.name.toLowerCase().includes(q) && d.text) {
      const i = d.text.toLowerCase().indexOf(q);
      const s = d.text.slice(Math.max(0, i - 25), i + q.length + 40).replace(/\s+/g, ' ');
      hit = `<div class="hit">…${esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), m => `<mark>${m}</mark>`)}…</div>`;
    }
    const dt = new Date(d.updated).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    el.innerHTML = `<img src="${url}" alt=""><div class="meta"><div class="name">${esc(d.name)}</div><div class="sub">${d.category ? `<span class="tag">${esc(d.category)}</span>` : ''}${d.pages.length} ${d.pages.length === 1 ? 'Seite' : 'Seiten'} · ${dt}${d.drive ? ' · in Drive' : ''}</div>${hit}</div>
      <button class="icon-btn" aria-label="Teilen"><svg class="i"><use href="#i-share"/></svg></button>`;
    el.querySelector('button').onclick = e => { e.stopPropagation(); sharePdf(d.pdf, d.name); };
    el.onclick = () => openDoc(d.id);
    let pressT;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', () => { pressT = setTimeout(() => docMenu(d), 550); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) el.addEventListener(ev, () => clearTimeout(pressT));
    list.appendChild(el);
  }
}
async function docMenu(d) {
  const v = await menu([{ label: 'Öffnen', value: 'open', icon: 'i-crop' }, { label: 'Teilen', value: 'share', icon: 'i-share' }, { label: 'Löschen', value: 'del', icon: 'i-trash' }]);
  if (v === 'open') openDoc(d.id);
  if (v === 'share') sharePdf(d.pdf, d.name);
  if (v === 'del' && confirm(`„${d.name}“ löschen?`)) { await db.deleteDoc(d.id); refreshList(); }
}
$('#q').addEventListener('input', renderList);

async function openDoc(id) {
  const d = await db.getDoc(id);
  if (!d) return;
  doc = { ...d, isNew: false };
  doc.pages = d.pages.map(p => ({ ...p }));
  doc.pages.forEach(setUrl);
  cur = 0; dirty = false;
  openEdit();
}

// ---------- Aufnehmen / Importieren ----------
async function addFromCamera() {
  const files = await pickFiles($('#inCam'));
  if (files.length) await addFiles(files, true);
}
async function addFromImport() {
  const files = await pickFiles($('#inImp'));
  if (files.length) await addFiles(files, files.length === 1);
}
async function addFiles(files, askCrop) {
  if (!doc) { doc = newDoc(); cur = 0; dirty = false; }
  for (let i = 0; i < files.length; i++) {
    busy(files.length > 1 ? `Seite ${i + 1} von ${files.length} wird erkannt…` : 'Blatt wird erkannt…');
    await nextFrame();
    let c;
    try { c = await loadImage(files[i]); } catch { busy(false); toast('Bild konnte nicht geöffnet werden'); continue; }
    const detected = detectQuad(c);
    const quad = detected || fullQuad(c);
    busy(false);
    let finalQuad = quad, rot = 0;
    if (askCrop) {
      const r = await cropUI(c, quad, { detected: !!detected });
      if (!r) { if (!doc.pages.length) { doc = null; show('home'); } else openEdit(); return; }
      finalQuad = r.quad; rot = r.rot;
    }
    busy('Seite wird aufbereitet…'); await nextFrame();
    const p = { id: uid(), src: await canvasToBlob(c, 'image/jpeg', 0.92), sw: c.width, sh: c.height, quad: finalQuad, rot, filter: cfg.filter, marks: [] };
    srcCache.id = p.id; srcCache.canvas = c;
    await renderPage(p);
    doc.pages.push(p);
    cur = doc.pages.length - 1;
    dirty = true;
  }
  busy(false);
  openEdit();
}
async function addFromPdf(filesPromise) {
  const files = await (filesPromise || pickFiles($('#inPdf')));
  if (!files || !files.length) return;
  const f = files[0];
  busy('PDF wird geöffnet…'); await nextFrame();
  try {
    const pages = await loadPdfPages(f, (i, n) => busy(`PDF wird geöffnet (Seite ${i}/${n})…`, i / n));
    doc = { id: uid(), created: Date.now(), fields: null, kind: 'pdf', original: f, srcName: f.name, isNew: true,
      pages: pages.map((p, i) => ({ ...p, id: uid(), idx: i, marks: [] })) };
    doc.pages.forEach(setUrl);
    cur = 0; dirty = true;
    busy(false);
    openEdit();
  } catch (e) {
    busy(false); doc = null;
    toast('PDF konnte nicht geöffnet werden: ' + e.message, 5000);
  }
}
// PDF aus der Zwischenablage (vom iOS-Kurzbefehl als Base64-Text kopiert)
async function pdfFromClipboard(textPromise) {
  let text;
  try { text = await textPromise; } catch { toast('Kein Zugriff auf die Zwischenablage. Bitte bei „Einfügen“ tippen.', 4000); return null; }
  text = (text || '').trim();
  let name = 'Dokument.pdf';
  const m = text.match(/^SCANPDF\|([^|]*)\|/);
  if (m) { name = m[1] || name; text = text.slice(m[0].length); }
  text = text.replace(/\s+/g, '').replace(/^data:application\/pdf;base64,/, '');
  if (!/^JVBER/.test(text)) { toast('In der Zwischenablage ist kein PDF. Erst den Kurzbefehl „In Scanner“ im Teilen-Menü ausführen.', 5000); return null; }
  try {
    const bin = atob(text), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return [new File([bytes], name, { type: 'application/pdf' })];
  } catch { toast('PDF in der Zwischenablage ist beschädigt'); return null; }
}
async function pdfMenu() {
  const v = await menu([
    { label: 'Aus Zwischenablage (Kurzbefehl)', icon: 'i-pdf', run: () => ({ clip: navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText() : Promise.reject() }) },
    { label: 'Aus Dateien wählen', icon: 'i-img', run: () => ({ files: pickFiles($('#inPdf')) }) },
  ]);
  if (!v) return;
  doc = null;
  if (v.clip) addFromPdf(pdfFromClipboard(v.clip));
  else addFromPdf(v.files);
}
const fullQuad = c => [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }];

// ---------- Zuschneiden ----------
function cropUI(canvas, quad, { detected = true, title = 'Ecken anpassen', hint } = {}) {
  return new Promise(resolve => {
    show('crop');
    $('#cropTitle').textContent = title;
    $('#cropHint').textContent = hint || (detected ? 'Blatt erkannt. Ecken bei Bedarf verschieben.' : 'Kein Blatt erkannt. Ecken bitte auf die Blattecken ziehen.');
    const stage = $('#cropStage'), cv = $('#cropCanvas'), svg = $('#cropSvg'), loupe = $('#loupe');
    let q = quad.map(p => ({ ...p })), rot = 0, auto = q;
    let scale = 1, ox = 0, oy = 0;
    const isFull = () => q.every((p, i) => { const f = fullQuad(canvas)[i]; return Math.abs(p.x - f.x) < 2 && Math.abs(p.y - f.y) < 2; });
    function layout() {
      const W = stage.clientWidth - 40, H = stage.clientHeight - 40;
      scale = Math.min(W / canvas.width, H / canvas.height);
      const dw = Math.round(canvas.width * scale), dh = Math.round(canvas.height * scale);
      ox = Math.round((stage.clientWidth - dw) / 2); oy = Math.round((stage.clientHeight - dh) / 2);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = dw * dpr; cv.height = dh * dpr;
      Object.assign(cv.style, { left: ox + 'px', top: oy + 'px', width: dw + 'px', height: dh + 'px' });
      const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(canvas, 0, 0, cv.width, cv.height);
      Object.assign(svg.style, { left: 0, top: 0, width: stage.clientWidth + 'px', height: stage.clientHeight + 'px' });
      svg.setAttribute('viewBox', `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
      draw();
    }
    const toScreen = p => ({ x: ox + p.x * scale, y: oy + p.y * scale });
    function draw() {
      const s = q.map(toScreen);
      svg.innerHTML = `<polygon class="poly" points="${s.map(p => p.x + ',' + p.y).join(' ')}"/>` +
        s.map((p, i) => `<circle class="h" cx="${p.x}" cy="${p.y}" r="11"/><circle class="hit" data-i="${i}" cx="${p.x}" cy="${p.y}" r="30"/>`).join('');
      $('#cropFull').textContent = isFull() ? 'Automatisch' : 'Ganzes Bild';
    }
    let drag = -1, start = null;
    svg.onpointerdown = e => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i == null) return;
      drag = +i; svg.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, p: { ...q[drag] } };
      loupe.classList.remove('hidden');
      updLoupe();
    };
    svg.onpointermove = e => {
      if (drag < 0) return;
      q[drag] = {
        x: Math.min(canvas.width, Math.max(0, start.p.x + (e.clientX - start.x) / scale)),
        y: Math.min(canvas.height, Math.max(0, start.p.y + (e.clientY - start.y) / scale)),
      };
      draw(); updLoupe();
    };
    svg.onpointerup = svg.onpointercancel = () => { drag = -1; loupe.classList.add('hidden'); };
    function updLoupe() {
      const p = q[drag], g = loupe.getContext('2d'), Z = 3.2 / scale * (240 / 120) / 2;
      const sp = toScreen(p);
      loupe.style.left = sp.x < stage.clientWidth / 2 ? (stage.clientWidth - 132) + 'px' : '12px';
      const r = 120 / (scale * 3.2) * 2;
      g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240);
      g.drawImage(canvas, p.x - r / 2, p.y - r / 2, r, r, 0, 0, 240, 240);
      g.strokeStyle = '#6d93ff'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(120, 95); g.lineTo(120, 145); g.moveTo(95, 120); g.lineTo(145, 120); g.stroke();
      void Z;
    }
    const ro = new ResizeObserver(layout); ro.observe(stage);
    function done(v) {
      ro.disconnect(); svg.onpointerdown = svg.onpointermove = svg.onpointerup = null;
      $('#cropOk').onclick = $('#cropCancel').onclick = $('#cropFull').onclick = $('#cropRotate').onclick = null;
      resolve(v);
    }
    $('#cropOk').onclick = () => done({ quad: orderQuad(q), rot });
    $('#cropCancel').onclick = () => done(null);
    $('#cropFull').onclick = () => {
      if (isFull()) { const d = detectQuad(canvas); q = (d || auto).map(p => ({ ...p })); if (!d) toast('Kein Blatt erkannt'); }
      else q = fullQuad(canvas);
      draw();
    };
    $('#cropRotate').onclick = () => { rot = (rot + 1) % 4; toast(rot ? `Wird nach dem Zuschneiden um ${rot * 90}° gedreht` : 'Keine Drehung', 1600); };
    layout();
  });
}

// ---------- Bearbeiten ----------
function openEdit() {
  show('edit');
  const isPdf = doc.kind === 'pdf';
  $('#editTitle').textContent = doc.isNew ? (isPdf ? doc.srcName : 'Neuer Scan') : (doc.name || 'Dokument');
  for (const id of ['#filters', '#tCrop', '#tRot', '#tDel']) $(id).classList.toggle('hidden', isPdf);
  renderFilters();
  renderEditPage();
  renderThumbs();
}
function renderFilters() {
  const box = $('#filters'); box.innerHTML = '';
  const p = doc.pages[cur];
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.className = 'chip' + (p && p.filter === f.id ? ' on' : '');
    b.textContent = f.name;
    b.onclick = async () => {
      if (!p || p.filter === f.id) return;
      busy('Filter wird angewendet…'); await nextFrame();
      p.filter = f.id; await renderPage(p); busy(false); dirty = true;
      renderFilters(); renderEditPage(); renderThumbs();
    };
    box.appendChild(b);
  }
}
function pageBox(p, wrap) {
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const s = Math.min(W / p.vw, H / p.vh);
  const box = document.createElement('div');
  box.className = 'pagebox';
  box.style.width = Math.floor(p.vw * s) + 'px';
  box.style.height = Math.floor(p.vh * s) + 'px';
  box.innerHTML = `<img src="${p.url}" alt="" draggable="false">`;
  wrap.innerHTML = ''; wrap.appendChild(box);
  return { box, dispH: Math.floor(p.vh * s) };
}
function renderEditPage() {
  const wrap = $('#pageWrap');
  const p = doc.pages[cur];
  if (!p) { wrap.innerHTML = ''; return; }
  const { box, dispH } = pageBox(p, wrap);
  for (const m of p.marks) box.appendChild(markEl(m, dispH, color()));
}
function color() { return cfg.color; }
function markEl(m, dispH, col) {
  const el = document.createElement('div');
  el.className = 'mark' + (m.type === 'text' ? ' txt' : '');
  el.style.left = m.x * 100 + '%'; el.style.top = m.y * 100 + '%';
  if (m.type === 'sig') { el.style.width = m.w * 100 + '%'; el.style.height = m.h * 100 + '%'; el.innerHTML = `<img src="${m.img}" alt="">`; }
  else { el.textContent = m.text; el.style.fontSize = m.size * dispH + 'px'; el.style.color = m.color || col; }
  return el;
}
function renderThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  doc.pages.forEach((p, i) => {
    const t = document.createElement('button');
    t.className = 'thumb' + (i === cur ? ' on' : '');
    t.innerHTML = `<img src="${p.url}" alt=""><span>${i + 1}</span>`;
    t.onclick = () => { cur = i; renderFilters(); renderEditPage(); renderThumbs(); };
    box.appendChild(t);
  });
  const add = document.createElement('button');
  add.className = 'thumb add'; add.setAttribute('aria-label', 'Seite hinzufügen');
  add.innerHTML = '<svg class="i"><use href="#i-plus"/></svg>';
  add.onclick = async () => {
    await menu([{ label: 'Weitere Seite fotografieren', icon: 'i-cam', run: () => addFromCamera() }, { label: 'Aus Fotos hinzufügen', icon: 'i-img', run: () => addFromImport() }]);
  };
  if (doc.kind !== 'pdf') box.appendChild(add);
  const on = box.querySelector('.on'); if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
new ResizeObserver(() => { if (current === 'edit' && doc) renderEditPage(); }).observe($('#pageWrap'));

$('#tRot').onclick = async () => {
  const p = doc.pages[cur]; if (!p) return;
  busy('Drehen…'); await nextFrame();
  p.rot = (p.rot + 1) % 4; p.marks = []; await renderPage(p); busy(false); dirty = true;
  renderEditPage(); renderThumbs();
};
$('#tCrop').onclick = async () => {
  const p = doc.pages[cur]; if (!p) return;
  busy('Lade Originalfoto…'); await nextFrame();
  const c = await srcCanvas(p); busy(false);
  const r = await cropUI(c, p.quad, { detected: true, hint: 'Ecken verschieben. „Ganzes Bild“ nimmt das komplette Foto.' });
  if (r) {
    busy('Seite wird aufbereitet…'); await nextFrame();
    p.quad = r.quad; p.rot = (p.rot + r.rot) % 4; p.marks = [];
    await renderPage(p); busy(false); dirty = true;
  }
  openEdit();
};
$('#tDel').onclick = () => {
  if (!doc.pages.length) return;
  if (!confirm(`Seite ${cur + 1} löschen?`)) return;
  doc.pages.splice(cur, 1); dirty = true;
  if (!doc.pages.length) { doc = null; show('home'); return; }
  cur = Math.min(cur, doc.pages.length - 1);
  openEdit();
};
$('#editBack').onclick = () => {
  if (dirty && !confirm(doc.isNew ? 'Scan verwerfen?' : 'Änderungen verwerfen?')) return;
  doc = null; show('home'); refreshList();
};
$('#editDone').onclick = () => openSave();
$('#tSign').onclick = () => openSign();

// ---------- Texterkennung ----------
async function ensureOcr(pages, label) {
  const todo = pages.filter(p => !p.ocr);
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    const base = `${label}${todo.length > 1 ? ` (Seite ${doc.pages.indexOf(p) + 1})` : ''}…`;
    busy(base, 0);
    try {
      p.ocr = await recognize(p.view, m => {
        if (m.status === 'recognizing text') busy(base, (i + m.progress) / todo.length);
        else if (/load|initializ/.test(m.status)) busy('Texterkennung wird geladen…', null);
      });
    } catch (e) {
      busy(false);
      toast('Texterkennung fehlgeschlagen: ' + e.message, 4000);
      p.ocr = { text: '', lines: [] };
    }
  }
  busy(false);
}

// ---------- Unterschrift platzieren ----------
let signState = null;
async function openSign() {
  if (!cfg.sig) {
    const v = await menu([{ label: 'Unterschrift zeichnen', value: 'draw', icon: 'i-pen' }, { label: 'Unterschrift von Papier fotografieren', icon: 'i-cam', run: () => ({ photo: pickFiles($('#inSig')) }) }]);
    if (!v) return;
    const ok = v === 'draw' ? await drawSignature() : await photoSignature(v.photo);
    if (!ok) { openEdit(); return; }
  }
  await ensureOcr(doc.pages, 'Suche Unterschriftsfeld');
  // Seite mit Unterschriftsfeld suchen: aktuelle Seite zuerst, sonst die letzte mit Feld
  const spotsOf = p => findSignatureSpots(p.ocr);
  let page = cur;
  if (!spotsOf(doc.pages[cur]).some(s => s.kind === 'sig')) {
    for (let i = doc.pages.length - 1; i >= 0; i--) if (spotsOf(doc.pages[i]).some(s => s.kind === 'sig')) { page = i; break; }
  }
  signState = { page, backup: doc.pages.map(p => p.marks.map(m => ({ ...m }))) };
  show('sign');
  setupSignPage(true);
}
function setupSignPage(auto) {
  const p = doc.pages[signState.page];
  const sig = cfg.sig;
  const spots = findSignatureSpots(p.ocr || { lines: [] });
  signState.spots = spots;
  const hasSig = p.marks.some(m => m.type === 'sig');
  if (auto && !hasSig) {
    const aspect = sig.aspect * (p.vh / p.vw); // Verhältnis in relativen Koordinaten umrechnen
    const pl = placeSignature(spots, cfg.prefer, p.vw, p.vh, sig.aspect);
    if (pl) {
      p.marks.push({ type: 'sig', x: pl.x, y: pl.y, w: pl.w, h: pl.h, img: sig.url });
      if (pl.date && cfg.autoDate) p.marks.push(dateMark(pl.date));
      $('#signHint').textContent = `Erkannt: „${pl.spot.label}“${spots.filter(s => s.kind === 'sig').length > 1 ? ' – andere Felder sind orange markiert, antippen zum Wechseln' : ''}. Zum Verschieben ziehen, Ecke zum Vergrößern.`;
    } else {
      const w = 0.32, h = w / aspect;
      p.marks.push({ type: 'sig', x: 0.6, y: Math.min(0.85, 0.82 - h), w, h, img: sig.url });
      $('#signHint').textContent = 'Kein Unterschriftsfeld erkannt. Unterschrift an die richtige Stelle ziehen.';
    }
    dirty = true;
  } else {
    $('#signHint').textContent = 'Zum Verschieben ziehen, blaue Ecke zum Vergrößern.';
  }
  renderSign();
}
function dateMark(d) {
  const city = cfg.city;
  const dt = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return { type: 'text', text: city ? `${city}, ${dt}` : dt, x: d.x, y: d.y, size: d.size, color: cfg.color };
}
function renderSign() {
  const p = doc.pages[signState.page];
  const wrap = $('#signWrap');
  const { box, dispH } = pageBox(p, wrap);
  box.classList.add('interactive');
  const bw = parseFloat(box.style.width), bh = parseFloat(box.style.height);
  // andere erkannte Felder als Vorschlag anzeigen
  for (const s of signState.spots.filter(s => s.kind === 'sig')) {
    const b = boxFor(s, p.vw, p.vh, cfg.sig.aspect);
    const cur = p.marks.find(m => m.type === 'sig');
    if (cur && Math.abs(cur.x - b.x) < 0.02 && Math.abs(cur.y - b.y) < 0.02) continue;
    const el = document.createElement('div');
    el.className = 'spot';
    Object.assign(el.style, { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' });
    el.onclick = () => {
      const m = p.marks.find(m => m.type === 'sig');
      if (m) Object.assign(m, b); else p.marks.push({ type: 'sig', ...b, img: cfg.sig.url });
      // passendes "Ort, Datum" mitnehmen
      const pl = placeSignature([s, ...signState.spots.filter(x => x.kind === 'date')], '', p.vw, p.vh, cfg.sig.aspect);
      const t = p.marks.find(m => m.type === 'text');
      if (pl && pl.date) { if (t) Object.assign(t, { x: pl.date.x, y: pl.date.y, size: pl.date.size }); else if (cfg.autoDate) p.marks.push(dateMark(pl.date)); }
      $('#signHint').textContent = `„${s.label}“ gewählt.`;
      dirty = true; renderSign();
    };
    box.appendChild(el);
  }
  for (const m of p.marks) {
    const el = markEl(m, dispH, cfg.color);
    const rs = document.createElement('div'); rs.className = 'rs'; el.appendChild(rs);
    box.appendChild(el);
    let st = null;
    el.onpointerdown = e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      st = { x: e.clientX, y: e.clientY, m: { ...m }, resize: e.target === rs };
    };
    el.onpointermove = e => {
      if (!st) return;
      const dx = (e.clientX - st.x) / bw, dy = (e.clientY - st.y) / bh;
      if (st.resize) {
        if (m.type === 'sig') {
          const nw = Math.max(0.05, st.m.w + dx);
          m.w = nw; m.h = st.m.h * nw / st.m.w;
          el.style.width = m.w * 100 + '%'; el.style.height = m.h * 100 + '%';
        } else {
          const startW = el.offsetWidth / bw || 0.2;
          m.size = Math.max(0.006, st.m.size * (1 + dx / startW));
          el.style.fontSize = m.size * dispH + 'px';
        }
      } else {
        m.x = st.m.x + dx; m.y = st.m.y + dy;
        el.style.left = m.x * 100 + '%'; el.style.top = m.y * 100 + '%';
      }
      dirty = true;
    };
    el.onpointerup = el.onpointercancel = () => { st = null; };
  }
  $('#sPageLbl').textContent = `Seite ${signState.page + 1}/${doc.pages.length}`;
  $('#sPrev').style.visibility = signState.page > 0 ? '' : 'hidden';
  $('#sNext').style.visibility = signState.page < doc.pages.length - 1 ? '' : 'hidden';
  $('#sDateLbl').textContent = p.marks.some(m => m.type === 'text') ? 'Ohne Datum' : 'Ort, Datum';
}
new ResizeObserver(() => { if (current === 'sign' && signState) renderSign(); }).observe($('#signWrap'));
$('#sPrev').onclick = () => { if (signState.page > 0) { signState.page--; setupSignPage(false); } };
$('#sNext').onclick = () => { if (signState.page < doc.pages.length - 1) { signState.page++; setupSignPage(false); } };
$('#sRemove').onclick = () => { doc.pages[signState.page].marks = []; dirty = true; $('#signHint').textContent = 'Entfernt. Tippe ein orange markiertes Feld an oder „Fertig“.'; renderSign(); if (!signState.spots.some(s => s.kind === 'sig')) setupSignPage(true); };
$('#sDate').onclick = () => {
  const p = doc.pages[signState.page];
  const i = p.marks.findIndex(m => m.type === 'text');
  if (i >= 0) p.marks.splice(i, 1);
  else {
    const s = p.marks.find(m => m.type === 'sig');
    const spot = signState.spots.find(s => s.kind === 'date');
    if (spot) {
      const lh = spot.bbox.y1 - spot.bbox.y0, size = lh * 1.25;
      p.marks.push(dateMark({ x: spot.bbox.x0 / p.vw, y: (spot.bbox.y0 - lh * 0.95 - size) / p.vh, size: size / p.vh }));
    } else {
      const size = s ? s.h * 0.32 : 0.018;
      p.marks.push(dateMark({ x: s ? Math.max(0.03, s.x - 0.36) : 0.08, y: s ? s.y + s.h - size * 1.3 : 0.8, size }));
    }
    if (!cfg.city) toast('Tipp: In den Einstellungen deinen Ort hinterlegen.');
  }
  dirty = true; renderSign();
};
$('#signOk').onclick = () => { signState = null; openEdit(); };
$('#signCancel').onclick = () => { doc.pages.forEach((p, i) => { p.marks = signState.backup[i]; }); signState = null; openEdit(); };

// ---------- Unterschrift hinterlegen ----------
function saveSig(canvas) {
  const url = canvas.toDataURL('image/png');
  store.set('sig', { url, aspect: canvas.width / canvas.height });
}
function drawSignature() {
  return new Promise(resolve => {
    show('draw');
    const wrap = $('#padWrap'), pad = $('#pad');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let strokes = [], curS = null;
    function size() { pad.width = wrap.clientWidth * dpr; pad.height = wrap.clientHeight * dpr; redraw(); }
    function redraw() {
      const g = pad.getContext('2d');
      g.clearRect(0, 0, pad.width, pad.height);
      g.strokeStyle = cfg.color; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of strokes) drawStroke(g, s);
    }
    function drawStroke(g, s) {
      const W = pad.width, H = pad.height;
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i];
        g.lineWidth = b.w * dpr;
        g.beginPath();
        if (i >= 2) { const z = s[i - 2]; g.moveTo((z.x + a.x) / 2 * W, (z.y + a.y) / 2 * H); g.quadraticCurveTo(a.x * W, a.y * H, (a.x + b.x) / 2 * W, (a.y + b.y) / 2 * H); }
        else { g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); }
        g.stroke();
      }
    }
    const pt = e => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: e.timeStamp }; };
    pad.onpointerdown = e => { pad.setPointerCapture(e.pointerId); const p = pt(e); p.w = 3.2; curS = [p, { ...p }]; strokes.push(curS); redraw(); };
    pad.onpointermove = e => {
      if (!curS) return;
      for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
        const p = pt(ev), last = curS[curS.length - 1];
        const dist = Math.hypot((p.x - last.x) * pad.clientWidth, (p.y - last.y) * pad.clientHeight);
        if (dist < 1.5) continue;
        const v = dist / Math.max(1, p.t - last.t);
        p.w = Math.max(1.6, Math.min(4.2, last.w * 0.7 + (4.4 - v * 1.4) * 0.3));
        curS.push(p);
      }
      redraw();
    };
    pad.onpointerup = pad.onpointercancel = () => { curS = null; };
    const ro = new ResizeObserver(size); ro.observe(wrap);
    $('#drawClear').onclick = () => { strokes = []; redraw(); };
    const finish = v => { ro.disconnect(); resolve(v); };
    $('#drawCancel').onclick = () => { finish(false); };
    $('#drawOk').onclick = () => {
      if (!strokes.length) { toast('Bitte zuerst unterschreiben'); return; }
      redraw();
      const g = pad.getContext('2d'), d = g.getImageData(0, 0, pad.width, pad.height).data;
      const A = new Uint8ClampedArray(pad.width * pad.height);
      for (let i = 0; i < A.length; i++) A[i] = d[i * 4 + 3];
      const out = alphaToSignature(A, pad.width, pad.height, cfg.color);
      if (!out) { toast('Bitte zuerst unterschreiben'); return; }
      saveSig(out);
      toast('Unterschrift gespeichert');
      finish(true);
    };
  });
}
async function photoSignature(filesPromise) {
  const files = await (filesPromise || pickFiles($('#inSig')));
  if (!files.length) return false;
  busy('Foto wird geladen…'); await nextFrame();
  const c = await loadImage(files[0], 2000);
  busy(false);
  const inset = { x: c.width * 0.1, y: c.height * 0.25 };
  const q0 = [{ x: inset.x, y: inset.y }, { x: c.width - inset.x, y: inset.y }, { x: c.width - inset.x, y: c.height - inset.y }, { x: inset.x, y: c.height - inset.y }];
  const r = await cropUI(c, q0, { title: 'Unterschrift einrahmen', hint: 'Rahmen eng um die Unterschrift ziehen.' });
  if (!r) return false;
  busy('Hintergrund wird entfernt…'); await nextFrame();
  const w = rotate(warp(c, r.quad, 1600), r.rot);
  const sig = extractSignature(w, cfg.color);
  busy(false);
  if (!sig) { toast('Keine Unterschrift gefunden. Bitte dunkler Stift auf hellem Papier.'); return false; }
  saveSig(sig);
  toast('Unterschrift gespeichert');
  return true;
}

// ---------- Speichern und Teilen ----------
let lastPdf = null;
async function openSave() {
  if (!doc.pages.length) return;
  await ensureOcr(doc.pages, 'Text wird erkannt');
  if (!doc.fields) {
    doc.fields = analyse(doc.pages.map(p => p.ocr));
    if (doc.kind === 'pdf' && !doc.fields.title) doc.fields.title = doc.srcName.replace(/\.pdf$/i, '');
  }
  const allText = doc.pages.map(p => p.ocr ? p.ocr.text : '').join('\n');
  doc.suggestedCat = suggestCategory(allText, doc.fields.title);
  const cats = getCats().map(c => c.name);
  const cat = doc.category || doc.suggestedCat;
  $('#fCat').innerHTML = [...new Set([...cats, cat].filter(Boolean))].map(c => `<option>${esc(c)}</option>`).join('');
  $('#fCat').value = cat;
  $('#shareLbl').textContent = doc.kind === 'pdf' ? 'Teilen (z. B. per Mail zurück)' : 'Teilen / In Dateien sichern';
  show('save');
  $('#fDate').value = doc.fields.date || todayIso();
  $('#fTitle').value = doc.fields.title || '';
  $('#fAmount').value = doc.fields.amount || '';
  const found = [doc.fields.date && 'Datum', doc.fields.title && 'Titel', doc.fields.amount && 'Betrag'].filter(Boolean);
  if (found.length || doc.suggestedCat) found.push('Kategorie');
  $('#fInfo').textContent = found.length ? `Aus dem Dokument gelesen: ${found.join(', ')}. Bitte kurz prüfen.` : 'Nichts Eindeutiges erkannt, bitte ausfüllen.';
  updName();
  $('#saveActions').classList.remove('hidden');
  $('#shareActions').classList.add('hidden');
  lastPdf = null;
}
function readFields() { return { date: $('#fDate').value, title: $('#fTitle').value, amount: $('#fAmount').value }; }
function updName() { $('#fName').textContent = buildName(readFields()); }
for (const id of ['#fDate', '#fTitle', '#fAmount', '#fCat']) $(id).addEventListener('input', () => { updName(); $('#saveActions').classList.remove('hidden'); $('#shareActions').classList.add('hidden'); });
$('#saveBack').onclick = () => { doc.fields = readFields(); openEdit(); };

async function finalJpeg(p) {
  const c = await loadImage(p.view, 99999);
  const g = c.getContext('2d');
  for (const m of p.marks) {
    if (m.type === 'sig') {
      const img = new Image(); img.src = m.img; await img.decode();
      g.drawImage(img, m.x * c.width, m.y * c.height, m.w * c.width, m.h * c.height);
    } else {
      g.fillStyle = m.color || cfg.color; g.textBaseline = 'top';
      g.font = `${m.size * c.height}px Helvetica, Arial, sans-serif`;
      g.fillText(m.text, m.x * c.width, m.y * c.height);
    }
  }
  return canvasToBlob(c, 'image/jpeg', 0.85);
}

const wantDrive = () => drive.driveConfigured() && drive.driveCfg.auto;
// Google-Anmeldung muss direkt im Tipp starten (Popup), deshalb vor allem anderen
function startSignInIfNeeded() {
  if (!drive.driveConfigured() || drive.hasToken()) return null;
  const p = drive.signIn();
  p.catch(() => {});
  return p;
}
$('#btnSave').onclick = async () => {
  const signInP = wantDrive() ? startSignInIfNeeded() : null;
  const fields = readFields();
  let name = buildName(fields);
  // doppelte Namen vermeiden
  const others = (await db.allDocs()).filter(d => d.id !== doc.id).map(d => d.name);
  if (others.includes(name)) { let k = 2; while (others.includes(name.replace(/\.pdf$/, `-${k}.pdf`))) k++; name = name.replace(/\.pdf$/, `-${k}.pdf`); }
  const category = $('#fCat').value;
  try {
    let pdf;
    if (doc.kind === 'pdf') {
      busy('Unterschrift wird ins PDF gesetzt…'); await nextFrame();
      pdf = await stampPdf(doc.original, doc.pages, cfg.color);
    } else {
    const pages = [];
    for (let i = 0; i < doc.pages.length; i++) {
      busy(`PDF wird erstellt (Seite ${i + 1}/${doc.pages.length})…`, i / doc.pages.length); await nextFrame();
      const p = doc.pages[i];
      pages.push({ jpeg: await finalJpeg(p), w: p.vw, h: p.vh, ocr: p.ocr });
    }
    busy('PDF wird erstellt…', 1); await nextFrame();
    pdf = await buildPdf(pages, name.replace(/\.pdf$/, ''));
    }
    const tc = await loadImage(doc.kind === 'pdf' ? await finalJpeg(doc.pages[0]) : doc.pages[0].view, 240);
    if (category && category !== doc.suggestedCat) learn(fields.title, category);
    const record = {
      id: doc.id, created: doc.created, updated: Date.now(), name, fields, category, kind: doc.kind || 'scan',
      original: doc.original, srcName: doc.srcName, drive: doc.drive || null, drivePending: wantDrive(),
      text: doc.pages.map(p => p.ocr ? p.ocr.text : '').join('\n'),
      thumb: await canvasToBlob(tc, 'image/jpeg', 0.8), pdf,
      pages: doc.pages.map(({ url, ...rest }) => rest),
    };
    await db.putDoc(record);
    db.persist();
    doc.isNew = false; doc.name = name; doc.fields = fields; doc.category = category; dirty = false;
    lastPdf = { blob: pdf, name, record };
    busy(false);
    $('#saveActions').classList.add('hidden');
    $('#shareActions').classList.remove('hidden');
    $('#fName').textContent = name;
    $('#btnDrive').classList.toggle('hidden', !drive.driveConfigured());
    $('#btnDrive').disabled = false;
    if (wantDrive()) {
      if (signInP) { busy('Google-Anmeldung…'); try { await signInP; } catch (e) { busy(false); toast('Gespeichert. Für Drive bitte „In Google Drive hochladen“ tippen.', 4500); return; } }
      await toDrive();
    } else toast('Gespeichert');
  } catch (e) {
    busy(false);
    toast('Speichern fehlgeschlagen: ' + e.message, 5000);
  }
};
async function toDrive() {
  if (!lastPdf) return;
  const { blob, name, record } = lastPdf;
  busy('Wird in Google Drive hochgeladen…'); await nextFrame();
  try {
    const res = await drive.upload(blob, name, record.category, record.drive);
    record.drive = res; record.drivePending = false; doc && (doc.drive = res);
    await db.putDoc(record);
    busy(false);
    $('#btnDrive').disabled = true;
    toast(`In Google Drive: ${drive.driveCfg.root}/${record.category || ''}`);
  } catch (e) {
    busy(false);
    toast('Upload fehlgeschlagen: ' + e.message, 5000);
  }
}
$('#btnDrive').onclick = async () => {
  const p = startSignInIfNeeded();
  if (p) { try { await p; } catch (e) { toast(e.message, 4000); return; } }
  toDrive();
};
// Alle noch nicht hochgeladenen Dokumente nachholen
async function syncPending() {
  const p = startSignInIfNeeded();
  if (p) { try { await p; } catch (e) { toast(e.message, 4000); return; } }
  const pend = (await db.allDocs()).filter(d => d.drivePending && d.pdf);
  let ok = 0;
  for (let i = 0; i < pend.length; i++) {
    const d = pend[i];
    busy(`Google Drive: ${i + 1} von ${pend.length}…`, i / pend.length); await nextFrame();
    try { d.drive = await drive.upload(d.pdf, d.name, d.category, d.drive); d.drivePending = false; await db.putDoc(d); ok++; }
    catch (e) { busy(false); toast('Upload fehlgeschlagen: ' + e.message, 5000); break; }
  }
  busy(false);
  if (ok) toast(`${ok} ${ok === 1 ? 'Dokument' : 'Dokumente'} in Google Drive abgelegt`);
  refreshList();
}
async function sharePdf(blob, name) {
  if (!blob) return toast('Kein PDF vorhanden');
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') downloadPdf(blob, name); }
  } else downloadPdf(blob, name);
}
function downloadPdf(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
$('#btnShare').onclick = () => lastPdf && sharePdf(lastPdf.blob, lastPdf.name);
$('#btnDownload').onclick = () => lastPdf && downloadPdf(lastPdf.blob, lastPdf.name);
$('#btnHome').onclick = () => { doc = null; show('home'); refreshList(); };

// ---------- Einstellungen ----------
function openSettings() {
  show('settings');
  const s = cfg.sig;
  $('#sigPrev').innerHTML = s ? `<img src="${s.url}" alt="Unterschrift">` : '<span class="small">Noch keine Unterschrift hinterlegt</span>';
  $('#sigDelete').classList.toggle('hidden', !s);
  for (const b of $('#sigColor').children) b.classList.toggle('on', b.dataset.c === cfg.color);
  $('#setCity').value = cfg.city; $('#setPrefer').value = cfg.prefer; $('#setAutoDate').checked = cfg.autoDate;
  renderCatList();
  $('#setClientId').value = drive.driveCfg.clientId; $('#setRoot').value = drive.driveCfg.root; $('#setAuto').checked = drive.driveCfg.auto;
  updDrive();
  const sel = $('#setFilter'); sel.innerHTML = FILTERS.map(f => `<option value="${f.id}">${f.name}</option>`).join(''); sel.value = cfg.filter;
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
    $('#storageInfo').textContent = `Alle Dokumente bleiben auf diesem Gerät (${(e.usage / 1048576).toFixed(1)} MB belegt).`;
  }).catch(() => {});
}
$('#btnSettings').onclick = openSettings;
$('#setBack').onclick = () => { show('home'); refreshList(); };
$('#setCity').oninput = e => store.set('city', e.target.value.trim());
$('#setPrefer').oninput = e => store.set('prefer', e.target.value.trim());
$('#setAutoDate').onchange = e => store.set('autoDate', e.target.checked);
$('#setFilter').onchange = e => store.set('filter', e.target.value);
$('#sigDraw').onclick = async () => { await drawSignature(); openSettings(); };
$('#sigPhoto').onclick = async () => { await photoSignature(); openSettings(); };
$('#sigImage').onclick = async () => {
  const files = await pickFiles($('#inSigImg'));
  if (!files.length) return;
  busy('Bild wird verarbeitet…'); await nextFrame();
  try {
    const c = await loadImage(files[0], 1600);
    const g = c.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let transparent = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] < 200) transparent++;
    let sig;
    if (transparent > d.length / 16 * 0.2) { // freigestelltes PNG: Transparenz direkt nutzen
      const A = new Uint8ClampedArray(c.width * c.height);
      for (let i = 0; i < A.length; i++) { const j = i * 4, dark = 255 - (d[j] + d[j + 1] + d[j + 2]) / 3; A[i] = d[j + 3] * Math.min(1, dark / 60 + 0.2); }
      sig = alphaToSignature(A, c.width, c.height, cfg.color);
    } else sig = extractSignature(c, cfg.color);
    busy(false);
    if (!sig) return toast('Keine Unterschrift im Bild gefunden');
    saveSig(sig); toast('Unterschrift gespeichert');
  } catch (e) { busy(false); toast('Bild konnte nicht gelesen werden'); }
  openSettings();
};
function renderCatList() {
  const box = $('#catList'); box.innerHTML = '';
  const cats = getCats();
  cats.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'catrow';
    row.innerHTML = `<input class="n" value="${esc(c.name)}" placeholder="Name"><input class="k" value="${esc(c.kw)}" placeholder="Stichwörter, mit Komma"><button class="icon-btn" aria-label="Entfernen"><svg class="i"><use href="#i-trash"/></svg></button>`;
    const [n, k] = row.querySelectorAll('input');
    n.onchange = () => { const cs = getCats(); cs[i].name = n.value.trim() || cs[i].name; setCats(cs); };
    k.onchange = () => { const cs = getCats(); cs[i].kw = k.value; setCats(cs); };
    row.querySelector('button').onclick = () => { const cs = getCats(); cs.splice(i, 1); setCats(cs); renderCatList(); };
    box.appendChild(row);
  });
}
$('#catAdd').onclick = () => { const cs = getCats(); cs.push({ name: 'Neue Kategorie', kw: '' }); setCats(cs); renderCatList(); };
$('#catReset').onclick = () => { if (confirm('Kategorien auf Standard zurücksetzen?')) { resetCats(); renderCatList(); } };
function updDrive() {
  const conf = drive.driveConfigured(), tok = drive.hasToken();
  $('#driveState').textContent = !conf ? 'Nicht eingerichtet: Client-ID eintragen (Anleitung bekommst du von mir).' : tok ? `Verbunden. Ablage: ${drive.driveCfg.root}/<Kategorie>` : 'Eingerichtet. Beim Speichern meldet sich die App bei Bedarf kurz bei Google an (gilt jeweils ca. 1 Stunde).';
  $('#driveIn').classList.toggle('hidden', !conf || tok);
  $('#driveOut').classList.toggle('hidden', !tok);
}
$('#setClientId').onchange = e => { drive.driveCfg.clientId = e.target.value.trim(); drive.preload(); updDrive(); };
$('#setRoot').onchange = e => { drive.driveCfg.root = e.target.value.trim() || 'Scanner'; };
$('#setAuto').onchange = e => { drive.driveCfg.auto = e.target.checked; };
$('#driveIn').onclick = async () => { try { await drive.signIn(); toast('Mit Google Drive verbunden'); } catch (e) { toast(e.message, 4000); } updDrive(); if (drive.hasToken() && (await db.allDocs()).some(d => d.drivePending)) syncPending(); };
$('#driveOut').onclick = () => { drive.signOut(); updDrive(); };
$('#sigDelete').onclick = () => { if (confirm('Unterschrift löschen?')) { localStorage.removeItem('sc_sig'); openSettings(); } };
$('#sigColor').onclick = async e => {
  const c = e.target.dataset && e.target.dataset.c; if (!c) return;
  store.set('color', c);
  const s = cfg.sig;
  if (s) { // vorhandene Unterschrift umfärben
    const img = new Image(); img.src = s.url; await img.decode();
    const cv = makeCanvas(img.naturalWidth, img.naturalHeight), g = cv.getContext('2d');
    g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = c; g.fillRect(0, 0, cv.width, cv.height);
    saveSig(cv);
  }
  openSettings();
};

// ---------- Start ----------
$('#btnScan').onclick = () => { doc = null; addFromCamera(); };
$('#btnImport').onclick = () => { doc = null; addFromImport(); };
$('#btnPdf').onclick = pdfMenu;
$('#syncBanner').onclick = syncPending;
drive.preload();
refreshList();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
// für Tests
window.__scanner = { get doc() { return doc; }, addFiles, openSign, openSave };

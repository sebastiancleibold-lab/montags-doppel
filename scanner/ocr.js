// Texterkennung (Tesseract, läuft lokal) und Auswertung: Datum, Titel, Betrag, Unterschriftsfelder.

const VENDOR = new URL('./vendor/', import.meta.url).href;
let workerPromise = null;
let progressCb = null;

export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(VENDOR + 'tesseract.min.js');
      return window.Tesseract.createWorker('deu', 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR + 'tesseract-core',
        langPath: VENDOR + 'lang',
        logger: m => progressCb && progressCb(m),
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// Ergebnis: { text, lines: [{ text, bbox, words: [{ text, bbox }] }] } mit Pixelkoordinaten des Bildes
export async function recognize(blob, onProgress) {
  const worker = await getWorker();
  progressCb = onProgress;
  try {
    const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      const words = (l.words || []).filter(w => w.text.trim()).map(w => ({ text: w.text, bbox: w.bbox, conf: w.confidence }));
      if (words.length) lines.push({ text: words.map(w => w.text).join(' '), bbox: l.bbox, words });
    }
    return { text: data.text || '', lines };
  } finally {
    progressCb = null;
  }
}

// ---------- Auswertung für den Dateinamen ----------

const MONTHS = { jan: 1, januar: 1, feb: 2, februar: 2, 'mär': 3, mar: 3, mrz: 3, 'märz': 3, maerz: 3, apr: 4, april: 4, mai: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, nov: 11, november: 11, dez: 12, dezember: 12 };

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  if (dt.getTime() > Date.now() + 400 * 864e5) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function findDates(text) {
  const out = [];
  const add = (iso, idx) => iso && out.push({ iso, idx });
  let m;
  const r1 = /(^|\D)(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
  while ((m = r1.exec(text))) add(validDate(+m[4], +m[3], +m[2]), m.index + m[1].length);
  const r2 = /(^|\D)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
  while ((m = r2.exec(text))) add(validDate(+m[2], +m[3], +m[4]), m.index + m[1].length);
  const r3 = /(^|\D)(\d{1,2})\.?\s*(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mär|mrz|apr|jun|jul|aug|sept|sep|okt|nov|dez)\.?\s*(\d{4})/gi;
  while ((m = r3.exec(text))) add(validDate(+m[4], MONTHS[m[3].toLowerCase()], +m[2]), m.index + m[1].length);
  return out;
}

export function guessDate(text) {
  const dates = findDates(text);
  if (!dates.length) return '';
  const lower = text.toLowerCase();
  // Datum direkt hinter einem passenden Stichwort bevorzugen
  const keys = ['rechnungsdatum', 'belegdatum', 'kaufdatum', 'datum', 'date', 'vom'];
  for (const k of keys) {
    let i = lower.indexOf(k);
    while (i >= 0) {
      const d = dates.find(d => d.idx >= i && d.idx - i < k.length + 25);
      if (d && !/liefer|fällig|faellig|leistungs|geburt/.test(lower.slice(Math.max(0, i - 12), i))) return d.iso;
      i = lower.indexOf(k, i + 1);
    }
  }
  return dates[0].iso;
}

const AMOUNT_RE = /(^|[^\d,.])(\d{1,3}(?:[.\s']\d{3})+|\d+)\s?[,.]\s?(\d{2})(?!\d|\.\d)/g;

function amountsIn(s) {
  const out = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(s))) out.push(parseFloat(m[2].replace(/[.\s']/g, '') + '.' + m[3]));
  return out;
}

export function guessAmount(lines) {
  const strong = /(gesamtbetrag|gesamtsumme|rechnungsbetrag|endbetrag|zahlbetrag|zu zahlen|summe|gesamt|total|brutto|betrag)/i;
  const weak = /(netto|mwst|ust|steuer|rabatt|zwischensumme|gegeben|rückgeld|rueckgeld)/i;
  let best = null;
  lines.forEach((l, i) => {
    const t = l.text;
    if (!strong.test(t) || (weak.test(t) && !/brutto|gesamt/i.test(t))) return;
    let vals = amountsIn(t);
    if (!vals.length && lines[i + 1]) vals = amountsIn(lines[i + 1].text);
    for (const v of vals) if (!best || v > best) best = v;
  });
  if (best == null) {
    // sonst: größter Betrag mit Euro-Zeichen
    for (const l of lines) if (/€|eur/i.test(l.text)) for (const v of amountsIn(l.text)) if (!best || v > best) best = v;
  }
  return best == null ? '' : best.toFixed(2).replace('.', ',');
}

const SKIP_TITLE = /^(rechnung|quittung|kassenbon|beleg|lieferschein|datum|seite|page|tel|telefon|fax|e-?mail|www|http|kunden|nr|steuer|ust|iban|bic|herr|frau|an|von|betreff|kopie|original)\b/i;

export function guessTitle(lines) {
  for (const l of lines.slice(0, 8)) {
    let t = l.text.replace(/[|_~*#<>»«"„“]/g, ' ').trim();
    if (t.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length < 3) continue;
    if (SKIP_TITLE.test(t)) continue;
    if (/\d{4,}/.test(t) && !/[A-Za-z]{4,}/.test(t)) continue;
    t = t.replace(/\b(gmbh|ag|kg|ohg|ug|e\.?\s?k\.?|mbh|co\.?|&|und|se|ltd|inc)\b\.?/gi, ' ');
    const words = t.split(/\s+/).filter(w => /[A-Za-zÄÖÜäöüß]{2,}/.test(w)).slice(0, 3);
    if (words.length) return camel(words.join(' '));
  }
  return '';
}

export function camel(s) {
  return s
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9 -]/g, ' ')
    .split(/[\s-]+/).filter(Boolean)
    .map(w => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w))
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('');
}

// Städtekürzel nach Sebastians Schema (Sitz des Ausstellers in München oder Leipzig)
export function citySuffix(lines) {
  // nur Briefkopf (erste Zeilen) und Fußzeile (letzte Zeilen) ansehen
  const head = lines.slice(0, 6).concat(lines.slice(-5)).map(l => l.text).join(' ');
  if (/m[üu]e?nchen/i.test(head)) return 'MUC';
  if (/leipzig/i.test(head)) return 'LPZ';
  return '';
}

export function analyse(ocrPages) {
  const lines = ocrPages.flatMap(p => p.lines);
  const text = ocrPages.map(p => p.text).join('\n');
  let title = guessTitle(lines);
  const suf = citySuffix(ocrPages[0]?.lines || []);
  if (title && suf && !title.endsWith(suf)) title = title.replace(/Muenchen|Munchen|Leipzig/g, '') + suf;
  return { date: guessDate(text), title, amount: guessAmount(lines) };
}

export function buildName({ date, title, amount }) {
  const d = (date || '').replace(/-/g, '') || todayIso().replace(/-/g, '');
  const t = camel(title || '') || 'Scan';
  const a = (amount || '').trim().replace(/[€\s]/g, '');
  let parts = [d, t];
  if (a) {
    const m = a.match(/^(\d+(?:[.']\d{3})*|\d+)(?:[,.](\d{1,2}))?$/);
    if (m) parts.push(m[1].replace(/[.']/g, '') + '_' + (m[2] || '00').padEnd(2, '0'));
  }
  return parts.join('_') + '.pdf';
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Unterschriftsfelder finden ----------

const SIG_RE = /^(unterschrift|unterschriften|signature|unterzeichner|unterzeichnet|signatur|zeichnungsberechtigt)/i;
const DATE_RE = /^(datum|date)/i;
const ORT_RE = /^(ort|place)\b/i;

function union(bbs) {
  return { x0: Math.min(...bbs.map(b => b.x0)), y0: Math.min(...bbs.map(b => b.y0)), x1: Math.max(...bbs.map(b => b.x1)), y1: Math.max(...bbs.map(b => b.y1)) };
}

// Liefert Kandidaten { kind: 'sig'|'date', label, bbox } in Bildpixeln
export function findSignatureSpots(ocr) {
  const spots = [];
  for (const line of ocr.lines) {
    const ws = line.words;
    const lh = Math.max(...ws.map(w => w.bbox.y1 - w.bbox.y0));
    // Wörter einer Zeile in Gruppen teilen, wo große Lücken sind (z.B. "Ort, Datum      Unterschrift Mieter")
    const groups = [];
    let cur = [ws[0]];
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].bbox.x0 - ws[i - 1].bbox.x1 > lh * 2.2) { groups.push(cur); cur = []; }
      cur.push(ws[i]);
    }
    groups.push(cur);
    for (const g of groups) {
      const clean = g.map(w => w.text.replace(/[^\wÄÖÜäöüß]/g, ''));
      const label = g.map(w => w.text).join(' ');
      const si = clean.findIndex(t => SIG_RE.test(t));
      if (si >= 0 && g.length <= 7) {
        spots.push({ kind: 'sig', label, bbox: union(g.map(w => w.bbox)), colon: /:\s*$/.test(label) });
      } else if (g.length <= 4 && clean.some(t => DATE_RE.test(t)) && clean.some(t => ORT_RE.test(t))) {
        spots.push({ kind: 'date', label, bbox: union(g.map(w => w.bbox)) });
      }
    }
  }
  return spots;
}

// Wählt das passende Feld (bevorzugtes Stichwort, sonst das letzte auf der Seite) und berechnet die Platzierung.
export function placeSignature(spots, prefer, pageW, pageH, sigAspect) {
  const sigs = spots.filter(s => s.kind === 'sig');
  if (!sigs.length) return null;
  let pick = null;
  if (prefer) pick = sigs.find(s => s.label.toLowerCase().includes(prefer.toLowerCase()));
  if (!pick) pick = sigs[sigs.length - 1];
  return { spot: pick, ...boxFor(pick, pageW, pageH, sigAspect), date: dateFor(spots, pick, pageW, pageH) };
}

export function boxFor(spot, pageW, pageH, sigAspect) {
  const b = spot.bbox, lh = b.y1 - b.y0;
  let h = lh * 3.6, w = h * sigAspect;
  const maxW = Math.max(b.x1 - b.x0, pageW * 0.22) * 1.5;
  if (w > maxW) { w = maxW; h = w / sigAspect; }
  let x, y;
  if (spot.colon) { x = b.x1 + lh; y = b.y1 - h * 0.85; }
  else { x = b.x0; y = b.y0 - lh * 0.55 - h; }
  x = Math.min(Math.max(0, x), pageW - w); y = Math.min(Math.max(0, y), pageH - h);
  return { x: x / pageW, y: y / pageH, w: w / pageW, h: h / pageH };
}

function dateFor(spots, sig, pageW, pageH) {
  const dates = spots.filter(s => s.kind === 'date');
  if (!dates.length) return null;
  const sy = (sig.bbox.y0 + sig.bbox.y1) / 2;
  const sx = sig.bbox.x0;
  dates.sort((a, b) => (Math.abs((a.bbox.y0 + a.bbox.y1) / 2 - sy) * 4 + Math.abs(a.bbox.x0 - sx)) - (Math.abs((b.bbox.y0 + b.bbox.y1) / 2 - sy) * 4 + Math.abs(b.bbox.x0 - sx)));
  const d = dates[0], lh = d.bbox.y1 - d.bbox.y0;
  if (Math.abs((d.bbox.y0 + d.bbox.y1) / 2 - sy) > lh * 6) return null;
  const size = lh * 1.25;
  return { x: d.bbox.x0 / pageW, y: (d.bbox.y0 - lh * 0.95 - size) / pageH, size: size / pageH };
}

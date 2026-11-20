// Vorhandene PDFs öffnen (pdf.js), Text mit Positionen auslesen und Unterschriften ins Original stempeln (pdf-lib).
import { loadScript } from './ocr.js';
import { canvasToBlob, makeCanvas } from './imgproc.js';

const V = new URL('./vendor/', import.meta.url).href;

async function lib() {
  await loadScript(V + 'pdfjs/pdf.min.js');
  const l = window.pdfjsLib;
  l.GlobalWorkerOptions.workerSrc = V + 'pdfjs/pdf.worker.min.js';
  return l;
}

// Liefert Seiten { view (JPEG), vw, vh, ocr|null, pdfT } – pdfT bildet PDF-Koordinaten auf Bildpixel ab
export async function loadPdfPages(blob, onPage, maxSide = 1800) {
  const l = await lib();
  const pdf = await l.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onPage && onPage(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, maxSide / Math.max(v1.width, v1.height)) });
    const c = makeCanvas(vp.width, vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const tc = await page.getTextContent();
    pages.push({ view: await canvasToBlob(c, 'image/jpeg', 0.9), vw: c.width, vh: c.height, ocr: textToOcr(tc.items, vp), pdfT: Array.from(vp.transform) });
    page.cleanup();
  }
  await pdf.destroy();
  return pages;
}

function textToOcr(items, vp) {
  const words = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform, h = Math.hypot(t[2], t[3]) || it.height || 10;
    const [a, b, c, d] = vp.convertToViewportRectangle([t[4], t[5] - h * 0.22, t[4] + it.width, t[5] + h * 0.8]);
    const x0 = Math.min(a, c), x1 = Math.max(a, c), y0 = Math.min(b, d), y1 = Math.max(b, d);
    // Text-Stück in Wörter teilen, Position anteilig nach Zeichen
    const n = it.str.length, cw = (x1 - x0) / Math.max(1, n);
    const re = /\S+/g; let m;
    while ((m = re.exec(it.str))) words.push({ text: m[0], bbox: { x0: x0 + m.index * cw, x1: x0 + (m.index + m[0].length) * cw, y0, y1 } });
  }
  if (words.length < 3) return null; // gescanntes PDF ohne Text -> später Texterkennung
  // zu Zeilen gruppieren
  words.sort((p, q) => (p.bbox.y0 + p.bbox.y1) - (q.bbox.y0 + q.bbox.y1));
  const lines = [];
  for (const w of words) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2, h = w.bbox.y1 - w.bbox.y0;
    const l = lines.find(l => Math.abs(l.cy - cy) < h * 0.5);
    if (l) l.words.push(w); else lines.push({ cy, words: [w] });
  }
  const out = lines.map(l => {
    l.words.sort((p, q) => p.bbox.x0 - q.bbox.x0);
    const bb = { x0: Math.min(...l.words.map(w => w.bbox.x0)), y0: Math.min(...l.words.map(w => w.bbox.y0)), x1: Math.max(...l.words.map(w => w.bbox.x1)), y1: Math.max(...l.words.map(w => w.bbox.y1)) };
    return { text: l.words.map(w => w.text).join(' '), bbox: bb, words: l.words };
  }).sort((p, q) => p.bbox.y0 - q.bbox.y0);
  return { text: out.map(l => l.text).join('\n'), lines: out };
}

// Bildpixel -> PDF-Koordinaten (Umkehrung von pdfT)
function inv(T, x, y) {
  const [a, b, c, d, e, f] = T, det = a * d - b * c;
  const X = x - e, Y = y - f;
  return { x: (d * X - c * Y) / det, y: (-b * X + a * Y) / det };
}

export async function stampPdf(original, pages, sigColor) {
  await loadScript(V + 'pdf-lib.min.js');
  const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;
  const doc = await PDFDocument.load(new Uint8Array(await original.arrayBuffer()), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const imgCache = new Map();
  const pdfPages = doc.getPages();
  for (const p of pages) {
    if (!p.marks.length) continue;
    const page = pdfPages[p.idx];
    for (const m of p.marks) {
      const X = m.x * p.vw, Y = m.y * p.vh;
      if (m.type === 'sig') {
        const W = m.w * p.vw, H = m.h * p.vh;
        const bl = inv(p.pdfT, X, Y + H), br = inv(p.pdfT, X + W, Y + H), tl = inv(p.pdfT, X, Y);
        let img = imgCache.get(m.img);
        if (!img) { img = await doc.embedPng(m.img); imgCache.set(m.img, img); }
        page.drawImage(img, {
          x: bl.x, y: bl.y,
          width: Math.hypot(br.x - bl.x, br.y - bl.y), height: Math.hypot(tl.x - bl.x, tl.y - bl.y),
          rotate: degrees(Math.atan2(br.y - bl.y, br.x - bl.x) * 180 / Math.PI),
        });
      } else {
        const size = m.size * p.vh;
        const o = inv(p.pdfT, X, Y + size * 0.8), o2 = inv(p.pdfT, X + 100, Y + size * 0.8);
        const k = Math.hypot(o2.x - o.x, o2.y - o.y) / 100;
        const col = hex(m.color || sigColor);
        page.drawText(m.text, { x: o.x, y: o.y, size: size * k, font, color: rgb(col[0], col[1], col[2]), rotate: degrees(Math.atan2(o2.y - o.y, o2.x - o.x) * 180 / Math.PI) });
      }
    }
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

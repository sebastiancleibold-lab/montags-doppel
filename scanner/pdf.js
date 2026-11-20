// PDF erzeugen: Seitenbild + unsichtbare Textebene aus der Texterkennung (durchsuchbar, Text markierbar).
import { loadScript } from './ocr.js';

const VENDOR = new URL('./vendor/', import.meta.url).href;

export async function buildPdf(pages, title) {
  await loadScript(VENDOR + 'pdf-lib.min.js');
  const { PDFDocument, StandardFonts, beginText, endText, setFontAndSize, setTextRenderingMode, TextRenderingMode, setTextMatrix, showText, pushGraphicsState, popGraphicsState } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(title || 'Scan');
  doc.setCreator('Scanner');
  doc.setProducer('Scanner (pdf-lib)');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const img = await doc.embedJpg(new Uint8Array(await p.jpeg.arrayBuffer()));
    const A4 = 595.28;
    const [W, H] = p.w <= p.h ? [A4, A4 * p.h / p.w] : [A4 * p.w / p.h, A4];
    const page = doc.addPage([W, H]);
    page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    if (p.ocr && p.ocr.lines.length) {
      const k = W / p.w;
      page.setFont(font);
      const key = page.fontKey;
      const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
      for (const line of p.ocr.lines) for (const w of line.words) {
        const text = safe(font, w.text);
        if (!text) continue;
        const bw = (w.bbox.x1 - w.bbox.x0) * k, bh = (w.bbox.y1 - w.bbox.y0) * k;
        const size = Math.max(2, bh * 0.9);
        const natural = font.widthOfTextAtSize(text, size);
        if (!natural) continue;
        const sx = bw / natural;
        ops.push(setFontAndSize(key, size), setTextMatrix(sx, 0, 0, 1, w.bbox.x0 * k, H - w.bbox.y1 * k + bh * 0.15), showText(font.encodeText(text)));
      }
      ops.push(endText(), popGraphicsState());
      page.pushOperators(...ops);
    }
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function safe(font, t) {
  try { font.encodeText(t); return t; } catch {
    const s = [...t].map(c => { try { font.encodeText(c); return c; } catch { return ''; } }).join('');
    return s.trim();
  }
}

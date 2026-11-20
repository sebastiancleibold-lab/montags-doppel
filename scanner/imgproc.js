// Bildverarbeitung: Kantenerkennung, Entzerrung, Filter, Unterschrift freistellen.
// Alles läuft lokal im Browser auf Canvas-Pixeldaten.

export const MAX_SIDE = 2600;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

// Bilddatei laden (EXIF-Drehung übernimmt der Browser) und auf MAX_SIDE verkleinern.
export async function loadImage(blob, maxSide = MAX_SIDE) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToBlob(c, type = 'image/jpeg', q = 0.9) {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Bild konnte nicht gespeichert werden'))), type, q));
}

function grayOf(data, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// ---------- Kantenerkennung ----------

// Liefert vier Ecken [TL, TR, BR, BL] in Pixeln des übergebenen Canvas oder null.
export function detectQuad(canvas) {
  const S = 420;
  const sc = S / Math.max(canvas.width, canvas.height);
  const w = Math.round(canvas.width * sc), h = Math.round(canvas.height * sc);
  const small = makeCanvas(w, h);
  const sg = ctx2d(small);
  sg.drawImage(canvas, 0, 0, w, h);
  const data = sg.getImageData(0, 0, w, h).data;
  const gray = boxBlur(boxBlur(grayOf(data, w * h), w, h, 1), w, h, 1);

  // Gradienten (Sobel)
  const mag = new Float32Array(w * h), ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
    const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    ang[i] = Math.atan2(gy, gx);
  }
  // Schwelle: oberes Perzentil, mindestens 40
  const sorted = Float32Array.from(mag).sort();
  const T = Math.max(40, sorted[Math.floor(sorted.length * 0.9)]);

  const cands = [];
  houghCandidates(mag, ang, w, h, T, cands);
  segmentCandidates(gray, w, h, cands);

  let best = null, bestScore = 0;
  for (const q of cands) {
    const s = scoreQuad(q, gray, w, h);
    if (s > bestScore) { bestScore = s; best = q; }
  }
  if (!best || bestScore < 0.42) return null;
  const q = best.map(p => ({ x: p.x / sc, y: p.y / sc }));
  return refineQuad(canvas, q).map(p => ({ x: clamp(p.x, 0, canvas.width), y: clamp(p.y, 0, canvas.height) }));
}

// Kanten in höherer Auflösung genauer einpassen (Geraden durch die stärksten Kantenpunkte).
function refineQuad(canvas, quad) {
  const sc = Math.min(1, 1300 / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * sc), h = Math.round(canvas.height * sc);
  const c = makeCanvas(w, h), g = ctx2d(c);
  g.drawImage(canvas, 0, 0, w, h);
  const gray = boxBlur(grayOf(g.getImageData(0, 0, w, h).data, w * h), w, h, 1);
  const at = (x, y) => {
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
  };
  const q = quad.map(p => ({ x: p.x * sc, y: p.y * sc }));
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  const R = Math.max(6, Math.round(Math.max(w, h) * 0.02));
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    if ((cx - (a.x + b.x) / 2) * nx + (cy - (a.y + b.y) / 2) * ny < 0) { nx = -nx; ny = -ny; }
    let pts = [];
    for (let k = 0; k <= 40; k++) {
      const t = 0.08 + 0.84 * k / 40, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      let bo = 0, bd = 0;
      for (let o = -R; o <= R; o += 0.5) {
        const x = px + nx * o, y = py + ny * o;
        if (x < 3 || y < 3 || x > w - 4 || y > h - 4) continue;
        const d = Math.abs(at(x + nx * 2, y + ny * 2) - at(x - nx * 2, y - ny * 2));
        if (d > bd) { bd = d; bo = o; }
      }
      if (bd > 18) pts.push({ x: px + nx * bo, y: py + ny * bo });
    }
    let line = null;
    for (let it = 0; it < 3 && pts.length >= 8; it++) {
      line = fitLine(pts);
      pts = pts.filter(p => Math.abs((p.x - line.x) * line.nx + (p.y - line.y) * line.ny) < 2.5);
    }
    lines.push(pts.length >= 8 ? fitLine(pts) : null);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const L1 = lines[(i + 3) % 4], L2 = lines[i];
    let p = null;
    if (L1 && L2) {
      const det = L1.nx * L2.ny - L1.ny * L2.nx;
      if (Math.abs(det) > 0.2) {
        const c1 = L1.nx * L1.x + L1.ny * L1.y, c2 = L2.nx * L2.x + L2.ny * L2.y;
        p = { x: (c1 * L2.ny - L1.ny * c2) / det, y: (L1.nx * c2 - c1 * L2.nx) / det };
        if (Math.hypot(p.x - q[i].x, p.y - q[i].y) > R * 2.5) p = null;
      }
    }
    out.push(p ? { x: p.x / sc, y: p.y / sc } : quad[i]);
  }
  return out;
}

function fitLine(pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // Richtung der Geraden
  return { x: mx, y: my, nx: -Math.sin(th), ny: Math.cos(th) };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function houghCandidates(mag, ang, w, h, T, out) {
  const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = 2 * diag + 1;
  const acc = new Float32Array(NT * NR);
  const cos = new Float32Array(NT), sin = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cos[t] = Math.cos(t * Math.PI / NT); sin[t] = Math.sin(t * Math.PI / NT); }
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, m = mag[i];
    if (m < T) continue;
    // nur Pixel nahe der Gradientenrichtung abstimmen lassen (spart Rauschen)
    let a = ang[i]; if (a < 0) a += Math.PI;
    const t0 = Math.round(a / Math.PI * NT);
    for (let d = -12; d <= 12; d++) {
      const t = (t0 + d + NT) % NT;
      const r = Math.round(x * cos[t] + y * sin[t]) + diag;
      acc[t * NR + r] += 1;
    }
  }
  const minVotes = Math.min(w, h) * 0.12;
  const lines = [];
  for (let k = 0; k < 24; k++) {
    let bi = -1, bv = minVotes;
    for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; bi = i; }
    if (bi < 0) break;
    const t = Math.floor(bi / NR), r = (bi % NR) - diag;
    lines.push({ t: t * Math.PI / NT, r, v: bv });
    for (let dt = -6; dt <= 6; dt++) for (let dr = -10; dr <= 10; dr++) {
      let tt = t + dt, rr = r + dr;
      if (tt < 0) { tt += NT; rr = -rr; } else if (tt >= NT) { tt -= NT; rr = -rr; }
      const ri = rr + diag;
      if (ri >= 0 && ri < NR) acc[tt * NR + ri] = 0;
    }
  }
  const angDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  const pairs = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    if (angDiff(A.t, B.t) > 0.5) continue;
    pairs.push([A, B]);
  }
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
    if (angDiff(a1.t, b1.t) < 0.8) continue;
    const pts = [inter(a1, b1), inter(b1, a2), inter(a2, b2), inter(b2, a1)];
    if (pts.some(p => !p || p.x < -0.15 * w || p.x > 1.15 * w || p.y < -0.15 * h || p.y > 1.15 * h)) continue;
    const q = orderQuad(pts);
    if (q && validQuad(q, w, h)) out.push(q);
  }
}

function inter(l1, l2) {
  const a = Math.cos(l1.t), b = Math.sin(l1.t), c = Math.cos(l2.t), d = Math.sin(l2.t);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (l1.r * d - b * l2.r) / det, y: (a * l2.r - l1.r * c) / det };
}

function segmentCandidates(gray, w, h, out) {
  // Otsu-Schwelle, dann größte helle Fläche -> konvexe Hülle -> größtes Viereck
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const n = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  for (const off of [0, 15, -15]) {
    const q = blobQuad(gray, w, h, thr + off);
    if (q) out.push(q);
  }
}

function blobQuad(gray, w, h, thr) {
  const lab = new Int32Array(w * h).fill(-1);
  let bestSize = 0, bestId = -1, id = 0;
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (lab[s] !== -1 || gray[s] <= thr) continue;
    let sp = 0, size = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && lab[i - 1] === -1 && gray[i - 1] > thr) { lab[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && lab[i + 1] === -1 && gray[i + 1] > thr) { lab[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && lab[i - w] === -1 && gray[i - w] > thr) { lab[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && lab[i + w] === -1 && gray[i + w] > thr) { lab[i + w] = id; stack[sp++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestSize < w * h * 0.08 || bestSize > w * h * 0.97) return null;
  const pts = [];
  for (let y = 0; y < h; y++) {
    let mn = -1, mx = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === bestId) { if (mn < 0) mn = x; mx = x; }
    if (mn >= 0) { pts.push({ x: mn, y }); if (mx !== mn) pts.push({ x: mx, y }); }
  }
  let hull = convexHull(pts);
  if (hull.length < 4) return null;
  hull = simplifyClosed(hull, 2.5);
  while (hull.length > 28) hull = simplifyClosed(hull, 2.5 + hull.length / 10);
  const q = maxAreaQuad(hull);
  if (!q) return null;
  const oq = orderQuad(q);
  return oq && validQuad(oq, w, h) ? oq : null;
}

function convexHull(p) {
  p = p.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

function simplifyClosed(pts, eps) {
  // Douglas-Peucker für geschlossene Polygone
  if (pts.length < 8) return pts;
  const dp = (a) => {
    if (a.length < 3) return a;
    const s = a[0], e = a[a.length - 1];
    let md = 0, mi = 0;
    for (let i = 1; i < a.length - 1; i++) {
      const d = distToSeg(a[i], s, e);
      if (d > md) { md = d; mi = i; }
    }
    if (md <= eps) return [s, e];
    const l = dp(a.slice(0, mi + 1)), r = dp(a.slice(mi));
    return l.slice(0, -1).concat(r);
  };
  // am weitesten entfernte Punkte als Teilung
  let far = 0, fd = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const a = dp(pts.slice(0, far + 1)), b = dp(pts.slice(far).concat([pts[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  let t = l ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function polyArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}

function maxAreaQuad(h) {
  const n = h.length;
  if (n === 4) return h;
  let best = 0, bq = null;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const q = [h[a], h[b], h[c], h[d]];
    const ar = polyArea(q);
    if (ar > best) { best = ar; bq = q; }
  }
  return bq;
}

export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // s ist im Uhrzeigersinn (y nach unten) ab ~links-oben; Start = Punkt mit kleinster x+y
  let k = 0, mn = Infinity;
  s.forEach((p, i) => { if (p.x + p.y < mn) { mn = p.x + p.y; k = i; } });
  return [0, 1, 2, 3].map(i => s[(k + i) % 4]);
}

function validQuad(q, w, h) {
  const area = polyArea(q);
  if (area < w * h * 0.12) return false;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cr = v1.x * v2.y - v1.y * v2.x;
    const an = Math.acos(clamp((v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9), -1, 1)) * 180 / Math.PI;
    if (an < 40 || an > 140) return false;
    if (cr > 0) return false; // muss konvex und gleich orientiert sein
    if (Math.hypot(v2.x, v2.y) < Math.min(w, h) * 0.15) return false;
  }
  return true;
}

function scoreQuad(q, gray, w, h) {
  // Anteil der Randpunkte, an denen innen und außen sich deutlich unterscheiden
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  const at = (x, y) => gray[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)];
  const sides = [];
  let signSum = 0, signN = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } // n zeigt nach innen
    const N = 40; let sup = 0, cnt = 0;
    for (let k = 3; k < N - 3; k++) {
      const t = k / N, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      cnt++;
      if (px < 2 || py < 2 || px > w - 3 || py > h - 3) { sup += 0.35; continue; }
      let bestD = 0;
      for (const o of [-1.5, 0, 1.5]) {
        const qx = px + nx * o, qy = py + ny * o;
        const d = at(qx + nx * 3, qy + ny * 3) - at(qx - nx * 3, qy - ny * 3);
        if (Math.abs(d) > Math.abs(bestD)) bestD = d;
      }
      if (Math.abs(bestD) > 14) { sup += 1; signSum += Math.sign(bestD); signN++; }
    }
    sides.push(sup / cnt);
  }
  const mean = sides.reduce((s, v) => s + v, 0) / 4, min = Math.min(...sides);
  const consistent = signN ? Math.abs(signSum) / signN : 0; // Papier innen konsequent heller/dunkler
  const areaFrac = polyArea(q) / (w * h);
  return (0.5 * mean + 0.5 * min) * (0.75 + 0.25 * consistent) * (0.85 + 0.15 * Math.sqrt(areaFrac));
}

// ---------- Entzerrung ----------

function homography(src, dst) {
  // findet H mit dst -> src (für Rückwärtsabbildung)
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i], { x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  return B.map((b, i) => b / A[i][i]);
}

export function warp(srcCanvas, quad, maxSide = MAX_SIDE) {
  const [tl, tr, br, bl] = quad;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let W = Math.max(d(tl, tr), d(bl, br)), H = Math.max(d(tl, bl), d(tr, br));
  const s = Math.min(1, maxSide / Math.max(W, H));
  W = Math.round(W * s); H = Math.round(H * s);
  const Hm = homography(quad, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const src = ctx2d(srcCanvas).getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H);
  const og = ctx2d(out);
  const img = og.createImageData(W, H), o = img.data;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const uu = u + 0.5, vv = v + 0.5;
      const z = Hm[6] * uu + Hm[7] * vv + 1;
      let x = (Hm[0] * uu + Hm[1] * vv + Hm[2]) / z - 0.5, y = (Hm[3] * uu + Hm[4] * vv + Hm[5]) / z - 0.5;
      x = clamp(x, 0, sw - 1.001); y = clamp(y, 0, sh - 1.001);
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const j = (v * W + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        o[j + c] = top + (bot - top) * fy;
      }
      o[j + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

export function rotate(canvas, quarterTurns) {
  const r = ((quarterTurns % 4) + 4) % 4;
  if (!r) return canvas;
  const out = r % 2 ? makeCanvas(canvas.height, canvas.width) : makeCanvas(canvas.width, canvas.height);
  const g = out.getContext('2d');
  g.translate(out.width / 2, out.height / 2);
  g.rotate(r * Math.PI / 2);
  g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// ---------- Filter ----------

// Hintergrundhelligkeit (Papierweiß inkl. Schatten) grob schätzen
function background(L, w, h) {
  const B = Math.max(8, Math.round(Math.max(w, h) / 90));
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    // 90. Perzentil per grober Näherung: Maximum der Blockmittelwerte von 4 Unterblöcken
    let mx = 0;
    const y0 = gy * B, x0 = gx * B, y1 = Math.min(h, y0 + B), x1 = Math.min(w, x0 + B);
    const hb = Math.max(1, (B / 2) | 0);
    for (let sy = y0; sy < y1; sy += hb) for (let sx = x0; sx < x1; sx += hb) {
      let s = 0, n = 0;
      for (let y = sy; y < Math.min(y1, sy + hb); y += 2) for (let x = sx; x < Math.min(x1, sx + hb); x += 2) { s += L[y * w + x]; n++; }
      if (n && s / n > mx) mx = s / n;
    }
    grid[gy * gw + gx] = mx;
  }
  // Maximum-Filter (Text verschwinden lassen), dann glätten
  let g2 = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let m = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = clamp(y + dy, 0, gh - 1), xx = clamp(x + dx, 0, gw - 1);
      m = Math.max(m, grid[yy * gw + xx]);
    }
    g2[y * gw + x] = m;
  }
  g2 = boxBlur(boxBlur(g2, gw, gh, 2), gw, gh, 2);
  return { grid: g2, gw, gh, B };
}

function bgAt(bg, x, y) {
  const fx = clamp(x / bg.B - 0.5, 0, bg.gw - 1), fy = clamp(y / bg.B - 0.5, 0, bg.gh - 1);
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(bg.gw - 1, x0 + 1), y1 = Math.min(bg.gh - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0, g = bg.grid, W = bg.gw;
  const t = g[y0 * W + x0] * (1 - ax) + g[y0 * W + x1] * ax, b = g[y1 * W + x0] * (1 - ax) + g[y1 * W + x1] * ax;
  return Math.max(30, t * (1 - ay) + b * ay);
}

export const FILTERS = [
  { id: 'magic', name: 'Verbessert' },
  { id: 'gray', name: 'Graustufen' },
  { id: 'bw', name: 'S/W' },
  { id: 'original', name: 'Original' },
];

export function applyFilter(canvas, filter) {
  if (filter === 'original') return canvas;
  const w = canvas.width, h = canvas.height;
  const out = makeCanvas(w, h);
  const og = ctx2d(out);
  og.drawImage(canvas, 0, 0);
  const img = og.getImageData(0, 0, w, h), d = img.data;
  const L = grayOf(d, w * h);
  const bg = background(L, w, h);
  if (filter === 'bw') {
    // normalisieren, dann adaptive Schwelle über Integralbild
    const N = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; N[i] = Math.min(255, L[i] / bgAt(bg, x, y) * 255); }
    const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += N[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + rs; } }
    const r = Math.max(8, Math.round(Math.max(w, h) / 60));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const mean = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      const v = N[y * w + x];
      const black = v < 150 || (v < mean - 18 && v < 215);
      const j = (y * w + x) * 4;
      d[j] = d[j + 1] = d[j + 2] = black ? 0 : 255;
    }
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4, b = bgAt(bg, x, y);
      if (filter === 'gray') {
        const v = Math.min(255, L[i] / b * 255);
        const c = 255 - (255 - v) * 1.35;
        d[j] = d[j + 1] = d[j + 2] = c < 0 ? 0 : c;
      } else {
        const k = 255 / b;
        for (let c = 0; c < 3; c++) {
          let v = Math.min(255, d[j + c] * k);
          v = 255 - (255 - v) * 1.45;
          d[j + c] = v < 0 ? 0 : v;
        }
        // leichte Sättigungsanhebung, damit Stempel/Markierungen farbig bleiben
        const m = (d[j] + d[j + 1] + d[j + 2]) / 3;
        for (let c = 0; c < 3; c++) d[j + c] = clamp(m + (d[j + c] - m) * 1.2, 0, 255);
      }
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

// ---------- Unterschrift ----------

// Freistellen: Papier wird transparent, Tinte bleibt (eingefärbt), Ergebnis wird auf die Tinte zugeschnitten.
export function extractSignature(canvas, color = '#14286e') {
  const w = canvas.width, h = canvas.height;
  const d = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const L = grayOf(d, w * h);
  const bg = background(L, w, h);
  const A = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = Math.min(255, L[i] / bgAt(bg, x, y) * 255);
    A[i] = clamp((215 - v) * 255 / 110, 0, 255);
  }
  return alphaToSignature(A, w, h, color);
}

export function alphaToSignature(A, w, h, color) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (A[y * w + x] > 90) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const ow = x1 - x0 + 1, oh = y1 - y0 + 1;
  const s = Math.min(1, 900 / ow);
  const tmp = makeCanvas(ow, oh), tg = ctx2d(tmp);
  const img = tg.createImageData(ow, oh), o = img.data;
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const j = (y * ow + x) * 4;
    o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = A[(y + y0) * w + x + x0];
  }
  tg.putImageData(img, 0, 0);
  if (s === 1) return tmp;
  const out = makeCanvas(ow * s, oh * s);
  const g2 = out.getContext('2d');
  g2.imageSmoothingQuality = 'high';
  g2.drawImage(tmp, 0, 0, out.width, out.height);
  return out;
}

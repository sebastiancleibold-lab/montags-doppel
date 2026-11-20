// Kategorien: Stichwörter + gelernte Zuordnung je Absender/Titel.
const DEFAULT = [
  { name: 'Wohnung', kw: 'miete, mietvertrag, nebenkosten, betriebskosten, hausverwaltung, vermieter, mieter, wohnungsgeber, hausgeld, übergabeprotokoll, eigentümer' },
  { name: 'Versicherung', kw: 'versicherung, police, versicherungsschein, versicherungsnummer, schadenmeldung' },
  { name: 'Steuer', kw: 'finanzamt, steuerbescheid, einkommensteuer, lohnsteuer, steuer-id, steuernummer, elster' },
  { name: 'Bank & Finanzen', kw: 'kontoauszug, depot, darlehen, kredit, sparkasse, volksbank, iban' },
  { name: 'Telefon & Internet', kw: 'telekom, vodafone, o2, telefónica, 1&1, mobilfunk, dsl, glasfaser, rundfunkbeitrag' },
  { name: 'Gesundheit', kw: 'arzt, praxis, apotheke, krankenkasse, rezept, zahnarzt, klinik, aok, tk ' },
  { name: 'Auto', kw: 'kfz, werkstatt, tüv, dekra, zulassung, autohaus, kennzeichen, tankstelle' },
  { name: 'Rechnungen', kw: 'rechnung, quittung, kassenbon, beleg, gesamtbetrag, summe, bestellung' },
  { name: 'Verträge', kw: 'vertrag, vereinbarung, kündigung, unterschrift' },
  { name: 'Sonstiges', kw: '' },
];
const get = (k, d) => { try { const v = localStorage.getItem('sc_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem('sc_' + k, JSON.stringify(v)); } catch {} };

export const getCats = () => get('cats', DEFAULT);
export const setCats = c => set('cats', c);
export const resetCats = () => set('cats', DEFAULT);

export function suggestCategory(text, title) {
  const learned = get('learned', {});
  const cats = getCats();
  if (title && learned[title] && cats.some(c => c.name === learned[title])) return learned[title];
  const t = ' ' + (text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = null, bs = 0;
  for (const c of cats) {
    const kws = c.kw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let s = 0;
    for (const k of kws) { let i = t.indexOf(k); while (i >= 0) { s++; i = t.indexOf(k, i + 1); } }
    if (s > bs) { bs = s; best = c.name; }
  }
  return best || (cats.find(c => c.name === 'Sonstiges') || cats[cats.length - 1] || { name: '' }).name;
}

export function learn(title, cat) {
  if (!title || !cat) return;
  const l = get('learned', {}); l[title] = cat; set('learned', l);
}

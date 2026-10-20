/* The quick-entry parser, ported from app.js.
 *
 * A typed line is the app's main input, so this is the one piece of logic that
 * must not merely "look right": `scripts/test-parity-money.mjs` lifts the
 * shipping parser out of app.js and runs it beside this module on the same
 * lines, refusing any difference in the resulting entry. That is why every
 * regex and every branch below is a copy rather than an improvement — the two
 * must answer the same question the same way until the cutover retires the old
 * one.
 *
 * Pure: no state, no DOM. `today()` is the only outside dependency, and
 * `quickEntryLegs` takes its ids and timestamp from the caller.
 */
import { localDateKey, parseAmount, today } from './format.ts';
import type { Entry } from '../lib/types.ts';

export interface ParsedSplitSlice {
  method: string;
  amount: number;
}

export interface ParsedEntry {
  error?: string;
  date?: string;
  type?: 'expense' | 'credit' | 'transfer';
  amount?: number;
  details?: string;
  category?: string;
  method?: string;
  transfer?: { from: string; to: string };
  split?: ParsedSplitSlice[];
}

/** The first euro-looking token in `raw` that carries more decimals than money
 *  has. A third decimal is a typo, not a rounding detail: the shipping app used
 *  to truncate it (4.477 → 4.47) while the validator dropped the row it made. */
export function overPreciseAmount(raw: unknown): string | null {
  for (const token of String(raw || '').match(/\d[\d.,]*/g) || []) {
    const text = token.replace(/[.,]+$/, '');
    if (/^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(text)) continue;       // a date, not money
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) continue;   // 1,200 / 1,200.50
    if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(text)) continue;             // 1.200.000
    const cut = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
    if (cut < 0) continue;                                           // whole euros
    if (/^\d{3,}$/.test(text.slice(cut + 1))) return text;
  }
  return null;
}

export function categoryFromDescription(desc: unknown): string {
  const d = String(desc || '').toLowerCase();
  if (/gift.?card|voucher/i.test(d)) return 'GC';
  if (/grocer|tesco|lidl|aldi|supervalu|dunnes|spar|centra|m&s|marks|supermarket|shop|market/i.test(d)) return 'gro';
  if (/bus|train|luas|dart|leap|taxi|uber|petrol|diesel|fuel|parking|toll|flight|ferry/i.test(d)) return 'travel';
  if (/rent|lease|mortgage|deposit|landlord/i.test(d)) return 'rent';
  return 'misc';
}

export function parseReceiptLine(line: string): { details: string; amount: number; category: string } | null {
  const s = String(line || '').trim();
  if (!s) return null;
  const m1 = s.match(/^[€$]?([\d,.]+)\s+(.+)/);
  const m2 = s.match(/(.+)\s+[€$]([\d,.]+)$/);
  let amt: number | null = null;
  let desc = '';
  if (m1) { amt = parseAmount(m1[1]); desc = m1[2]; }
  else if (m2) { amt = parseAmount(m2[2]); desc = m2[1]; }
  else { desc = s; }
  return { details: desc || s, amount: amt || 0, category: categoryFromDescription(desc) };
}

/* ── the description cleaner ──────────────────────────────────────────────── */

const QUICK_STOP = new Set([
  'the', 'a', 'an', 'i', 'my', 'our', 'some', 'any', 'just', 'only',
  'about', 'around', 'approx', 'approximately', 'am', 'pm',
  'income', 'received', 'salary', 'paid', 'got', 'paycheck', 'wage', 'wages',
  'refund', 'dividend', 'spent', 'expense', 'expenses', 'bought', 'cost',
  'costs', 'worth', 'total', 'amount', 'came',
]);
const QUICK_PREPS = new Set([
  'at', 'from', 'on', 'using', 'via', 'with', 'for', 'in', 'to', 'of', 'by',
  'per', 'each',
]);
const QUICK_BRAND_START = new Set(['the', 'a', 'an', 'in', 'on']);
const QUICK_CONNECTORS = new Set(['&', 'and']);
const QUICK_EDGE_PUNCT = /^[,.;:!?()[\]"'\-—-]+|[,.;:!?()[\]"'\-—-]+$/g;
const QUICK_LOWERCASE = new Set([...QUICK_PREPS, 'and']);

function isContentToken(t: string | null | undefined): boolean {
  return !!t && /[a-z0-9]/i.test(t) && !QUICK_CONNECTORS.has(t.toLowerCase())
    && !QUICK_STOP.has(t.toLowerCase()) && !QUICK_PREPS.has(t.toLowerCase());
}

function nextContentToken(tokens: string[], from: number): string | null {
  for (let j = from + 1; j < tokens.length; j++) {
    const nt = tokens[j].replace(QUICK_EDGE_PUNCT, '');
    if (nt && isContentToken(nt)) return nt;
  }
  return null;
}

/** Two-phase cleaner: strip provable value-noise, then keep the meaningful
 *  words — prepositions only between two content words, no consecutive
 *  duplicates, title-cased (`Spent €18.50 at Tesco from Revolut yesterday`
 *  → `Tesco`, `pint of Guinness` → `Pint of Guinness`). */
export function cleanQuickDescription(raw: unknown, amountText: string): string {
  const s = String(raw || '')
    .replace(amountText ? amountText : '', ' ')
    .replace(/[€£$]/g, ' ')
    .replace(/\b(?:euro|euros|eur)\b/ig, ' ')
    .replace(/\b(?:\d+\s+days?\s+ago|(?:last|this)\s+(?:night|morning|afternoon|evening|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|today|tonight|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/ig, ' ')
    .replace(/\b\d+(?:[.,]\d{1,2})?\s*(?:kg|g|ml|litres?|l|pcs)\b/ig, ' ')
    .replace(/\b\d+(?:[.,]\d{1,2})?\b/g, ' ')
    .replace(/\b(?:x|×|@)\s*\d+(?:[.,]\d{1,2})?\b/ig, ' ')
    .replace(/\b\d+(?:[.,]\d{1,2})?\s*[x×@]\b/ig, ' ')
    .replace(/\b(aib|revolut(?: savings)?|\brs\b|bank|current account|cash|notes|wallet|pocket)\b/ig, ' ')
    .replace(/[()[]"']+/g, ' ');

  const tokens = s.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const atHead = () => !kept.some(isContentToken);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(QUICK_EDGE_PUNCT, '');
    const low = t.toLowerCase();

    if (t && QUICK_CONNECTORS.has(low)) {
      const left = tokens[i - 1]?.replace(QUICK_EDGE_PUNCT, '');
      const right = tokens[i + 1]?.replace(QUICK_EDGE_PUNCT, '');
      if (kept.length && kept[kept.length - 1] === left
        && right && /[a-z0-9]/i.test(right)) kept.push(t);
      continue;
    }
    if (!t || !/[a-z0-9]/i.test(t)) continue;

    if (QUICK_STOP.has(low)) {
      const next = nextContentToken(tokens, i);
      if (QUICK_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0))) {
        kept.push(t);
      }
      continue;
    }

    if (QUICK_PREPS.has(low)) {
      const prevContent = kept.length > 0 && isContentToken(kept[kept.length - 1]);
      const next = nextContentToken(tokens, i);
      const brandStart = atHead() && QUICK_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0));
      if ((prevContent && next) || brandStart) kept.push(t);
      continue;
    }

    if (kept.length && kept[kept.length - 1].toLowerCase() === low) continue;
    kept.push(t);
  }

  const details = kept.join(' ')
    .replace(/\s*([,;:.])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .replace(QUICK_EDGE_PUNCT, '')
    .trim();
  if (!details) return 'Entry';
  return details.split(' ').map((w, idx) => {
    if (idx > 0 && QUICK_LOWERCASE.has(w.toLowerCase())) return w.toLowerCase();
    if (!/[a-z]/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

/** Every payment-method keyword with an amount immediately before or after it;
 *  two or more distinct methods means a mixed payment. An amount is claimed by
 *  one method only — without that, `aldi 12.40 cash` read as a €24.80 split. */
export function tryParseSplitSlices(lower: string): ParsedSplitSlice[] | null {
  const rules: Array<{ re: RegExp; method: string }> = [
    { re: /\b(?:cash|notes|wallet)\b/g, method: 'Cash' },
    { re: /\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+account\b|\bfrom\s+savings\b/g, method: 'RS' },
    { re: /\brevolut\b/g, method: 'Revolut' },
    { re: /\baib\b|\bbank\b|\bcurrent\s+account\b/g, method: 'AIB' },
    { re: /\b(?:aldi|aldi'?s)\b/g, method: 'AG' },
    { re: /\b(?:lidl|lidl'?s)\b/g, method: 'LG' },
    { re: /\b(?:tesco|tesco'?s)\b/g, method: 'TG' },
  ];
  const usedSpans: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => usedSpans.some(([a, b]) => s < b && e > a);
  const found: ParsedSplitSlice[] = [];
  for (const rule of rules) {
    const rx = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(lower)) !== null) {
      const beforeStart = Math.max(0, m.index - 60);
      const before = lower.slice(beforeStart, m.index);
      const afterStart = m.index + m[0].length;
      const after = lower.slice(afterStart, afterStart + 60);
      const numBefore = /(\d+(?:[.,]\d{1,2})?)\s*[€£$]?\s*$/.exec(before);
      const numAfter = /^\s*[€£$]?\s*(\d+(?:[.,]\d{1,2})?)\b/.exec(after);
      const span: [number, number] | null = numBefore
        ? [beforeStart + numBefore.index, beforeStart + numBefore.index + numBefore[1].length]
        : (numAfter ? [afterStart + numAfter.index + numAfter[0].indexOf(numAfter[1]), afterStart + numAfter.index + numAfter[0].indexOf(numAfter[1]) + numAfter[1].length] : null);
      rx.lastIndex = m.index + m[0].length;
      if (!span || overlaps(span[0], span[1])) continue;
      const amt = parseAmount(numBefore ? numBefore[1] : numAfter[1]);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      usedSpans.push(span);
      found.push({ method: rule.method, amount: amt });
    }
  }
  const byMethod = new Map<string, ParsedSplitSlice>();
  for (const slice of found) if (!byMethod.has(slice.method)) byMethod.set(slice.method, slice);
  const slices = [...byMethod.values()];
  return slices.length >= 2 ? slices : null;
}

/* ── the parser ───────────────────────────────────────────────────────────── */

export function parseNaturalLanguage(text: unknown): ParsedEntry | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const overPrecise = overPreciseAmount(raw);
  if (overPrecise) return { error: `${overPrecise} has more decimals than euros have cents - round it to two places first.` };
  const lower = raw.toLowerCase();

  let date = today();
  if (/\byesterday\b|last night/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() - 1); date = localDateKey(d);
  } else {
    const daysAgo = lower.match(/(\d+)\s+days?\s+ago/);
    if (daysAgo) {
      const d = new Date(); d.setDate(d.getDate() - Math.min(365, +daysAgo[1])); date = localDateKey(d);
    } else {
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (let i = 0; i < 7; i++) {
        if (new RegExp(`\\b(?:last|this)?\\s*${dayNames[i]}\\b`).test(lower)) {
          const d = new Date();
          let diff = (d.getDay() - i + 7) % 7;
          if (diff === 0) diff = 7;
          d.setDate(d.getDate() - diff);
          date = localDateKey(d);
          break;
        }
      }
    }
  }

  let amount = NaN;
  let amountText = '';
  const mult = raw.match(/(\d+(?:[.,]\d{1,2})?)\s*[x×@]\s*(?:€|£|\$|euros?\b|eur\b)?\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (mult) {
    const qty = parseAmount(mult[1]);
    const price = parseAmount(mult[2]);
    if (Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && qty <= 1000 && price > 0) {
      amount = Math.round(qty * price * 100) / 100;
      amountText = mult[0];
    }
  }
  if (!Number.isFinite(amount)) {
    const numRe = /(?:€|£|\$|euros?\b|eur\b)?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|£|\$|euros?\b|eur\b)?/gi;
    const candidates: Array<{ value: number; score: number; index: number; text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = numRe.exec(raw)) !== null) {
      const value = parseAmount(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const before = raw.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
      let score = 0;
      if (/[€£$]/.test(m[0]) || /\beuros?\b/.test(m[0])) score += 100;
      if (/\b(?:spent|paid|cost|costs|bought|worth|for|at|total|amount|came to|just|only|about|around|approx)\s*$/.test(before)) score += 60;
      if (/[.,]\d{1,2}$/.test(m[1])) score += 30;
      if (/^(?:st|nd|rd|th)\b/.test(after)) continue;
      if (/^\s*(?:x|×|things|items|coffees|drinks|people|days|times|tickets?|kg|g|ml|litres?|l|pints|bottles|each|per|apiece|of)\b/.test(after)) score -= 80;
      if (m.index + m[0].length >= raw.length - 1) score += 10;
      candidates.push({ value, score, index: m.index, text: m[0] });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score || b.index - a.index);
      amount = candidates[0].value;
      amountText = candidates[0].text;
    }
  }
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Include an amount, for example €18.50.' };

  const detectBrand = (): string | null => {
    if (/\b(?:tesco|tesco'?s)\b/.test(lower)) return 'TG';
    if (/\b(?:lidl|lidl'?s)\b/.test(lower)) return 'LG';
    if (/\b(?:aldi|aldi'?s)\b/.test(lower)) return 'AG';
    return null;
  };
  const detectMethodIn = (fragment: string): string | null => {
    if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b|\bfrom\s+savings\b/.test(fragment)) return 'RS';
    if (/\brevolut\b/.test(fragment)) return 'Revolut';
    if (/\baib\b|\bbank\b|current account/.test(fragment)) return 'AIB';
    if (/\bcash\b|notes|wallet|pocket/.test(fragment)) return 'Cash';
    if (/\b(?:tesco|tesco'?s)\b/.test(fragment)) return 'TG';
    if (/\b(?:lidl|lidl'?s)\b/.test(fragment)) return 'LG';
    if (/\b(?:aldi|aldi'?s)\b/.test(fragment)) return 'AG';
    return null;
  };
  const detectSource = (): string | null => {
    if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b|\bfrom\s+savings\b/.test(lower)) return 'RS';
    if (/\brevolut\b/.test(lower)) return 'Revolut';
    if (/\baib\b|\bbank\b|current account/.test(lower)) return 'AIB';
    if (/\bcash\b|notes|wallet|pocket/.test(lower)) return 'Cash';
    return null;
  };
  const brand = detectBrand();
  const source = detectSource();
  const isCardLoad = !!brand && (
    /\b(?:tesco|lidl|aldi)(?:'s)?\s+(?:card\s+|gc\s+|gift\s*card\s+)?(?:load(?:ed|s|ing)?|top\s*ups?|topped(?:\s*up)?|reload(?:ed|s|ing)?|recharge(?:d|s)?)\b(?!\s*(?:of|with)\b)/.test(lower)
    || /\b(?:load(?:ed|s|ing)?|top\s*ups?|topped(?:\s*up)?|reload(?:ed|s|ing)?|recharge(?:d|s)?)\s+(?:money\s+|funds\s+|[€$£]?\s*\d+(?:[.,]\d{1,2})?\s+)?(?:on|to|into|onto|in|up)?\s*(?:my\s+|the\s+)?(?:tesco|lidl|aldi)\b/.test(lower));
  const isGiftCardPurchase = isCardLoad
    || /gift.?card|\bgc\b|voucher|(?:put|add|load|top\s*up|topped\s*up|loaded)\s+(?:money\s+)?(?:on|to|into)\s+(?:my\s+)?(?:tesco|lidl|aldi)\b/i.test(lower)
    || /\b(?:top\s*up|top\s+up|add|load|put)\s+(?:my\s+)?(?:tesco|lidl|aldi)\b/i.test(lower)
    || /(?:tesco|lidl|aldi)\b.{0,24}\b(?:gift.?card|\bgc\b|voucher)\b/i.test(lower)
    || /\b(?:tesco|lidl|aldi)(?:'s)?\s+(?:card|voucher)\b/i.test(lower);
  const fundingSource = source || (isGiftCardPurchase && brand ? 'AIB' : null);
  const isTransferToCard = isGiftCardPurchase && !!brand && !!fundingSource && fundingSource !== brand;
  const method = source || brand || 'AIB';

  const isCredit = /\b(income|received|salary|paid into|got paid|paycheck|payday|wage|refund|dividend)\b/.test(lower);

  const details = cleanQuickDescription(raw, amountText);
  const guessed = parseReceiptLine(details) || { details, amount: 0, category: 'misc' };

  if (/\b(?:transfer(?:red|ring|s)?|moved?|sent)\b/.test(lower)) {
    const toPart = lower.match(/\b(?:to|into|onto)\s+([^,;]+)$/);
    const from = detectSource();
    const to = toPart ? detectMethodIn(toPart[1]) : null;
    if (from && to && from !== to) {
      return { date, type: 'transfer', transfer: { from, to }, amount, details, category: 'misc', method: to };
    }
  }
  if (isTransferToCard) {
    return { date, type: 'transfer', transfer: { from: fundingSource!, to: brand! }, amount, details, category: 'GC', method: brand! };
  }
  const splices = tryParseSplitSlices(lower);
  if (splices && splices.length >= 2) {
    const splitTotal = Math.round(splices.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
    const methodWords: Record<string, RegExp> = {
      Cash: /\b(?:cash|notes|wallet)\b/gi, RS: /\b(?:revolut\s+savings|\brs\b|savings\s+account)\b/gi,
      Revolut: /\brevolut\b/gi, AIB: /\b(?:aib|bank|current\s+account)\b/gi,
      AG: /\b(?:aldi|aldi'?s)\b/gi, LG: /\b(?:lidl|lidl'?s)\b/gi, TG: /\b(?:tesco|tesco'?s)\b/gi,
    };
    let cleanRaw = raw;
    for (const s of splices) { const mv = methodWords[s.method]; if (mv) cleanRaw = cleanRaw.replace(mv, ' '); }
    const splitDetails = cleanQuickDescription(cleanRaw, '') || 'Entry';
    return {
      date, type: isCredit ? 'credit' : 'expense', amount: splitTotal, details: splitDetails,
      category: isCredit ? 'misc' : guessed.category, method: splices[0].method, split: splices,
    };
  }
  return { date, type: isCredit ? 'credit' : 'expense', amount, details, category: isCredit ? 'misc' : guessed.category, method };
}

/** The ledger rows a parsed quick entry becomes: a two-leg transfer for a
 *  funded card, one leg per method sharing a `splitId`, or a single entry. */
export function quickEntryLegs(parsed: ParsedEntry | null, newId: () => string, nowIso: string): Entry[] {
  if (!parsed || parsed.error) return [];
  const note = 'Created with natural-language input';
  if (parsed.type === 'transfer' && parsed.transfer) {
    const transferId = newId();
    const base = { createdAt: nowIso, date: parsed.date, category: 'misc', details: parsed.details, amount: parsed.amount, note, transferId };
    return [
      { ...base, id: newId(), type: 'expense', method: parsed.transfer.from },
      { ...base, id: newId(), type: 'credit', method: parsed.transfer.to },
    ];
  }
  if (parsed.split && parsed.split.length >= 2) {
    const splitId = newId();
    return parsed.split.map((s) => ({
      id: newId(), createdAt: nowIso, date: parsed.date, type: parsed.type,
      category: parsed.category, details: parsed.details, amount: s.amount,
      method: s.method, note, splitId,
    }));
  }
  return [{
    id: newId(), createdAt: nowIso, date: parsed.date, type: parsed.type,
    category: parsed.category, details: parsed.details, amount: parsed.amount,
    method: parsed.method, note,
  }];
}

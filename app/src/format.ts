/* Money and date formatting, ported from app.js byte-for-byte where the value
 * is visible on screen.
 *
 * These are the strings that appear in parity checks (`€4.47`, `−€50.00`,
 * `October 2026`, `Oct 12`), so the port keeps the shipped expressions rather
 * than "improving" them: a formatter that rounds differently is a screen that
 * disagrees with the one it is replacing, and Gate C compares the two.
 */

/** Euros with two decimals and a real minus sign, as the ledger prints it. */
export const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '€0.00';
  const sign = n < 0 ? '−' : '';
  return `${sign}€${Math.abs(n).toFixed(2)}`;
};

/** A local (not UTC) YYYY-MM-DD. Transaction dates are local calendar days. */
export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const today = (): string => localDateKey();

export const monthKey = (date: string): string => String(date || '').slice(0, 7);

const MONTH_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FRIENDLY_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return MONTH_FORMATTER.format(new Date(Date.UTC(y, m - 1, 1)));
}

export function friendlyDate(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '-';
  return FRIENDLY_DATE_FORMATTER.format(new Date(iso + 'T00:00:00Z'));
}

export function daysInMonth(key: string): number {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function previousMonthKey(key: string): string {
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Amount parser: accepts `1.234,56`, `1,234.56`, `12,50`, a leading currency
 *  symbol or spaces, and rounds to cents. NaN when it is not an amount. */
export function parseAmount(raw: unknown): number {
  if (raw == null) return NaN;
  let text = String(raw).trim().replace(/[€$£\s]/g, '');
  if (!text || !/^\d[\d.,]*$/.test(text)) return NaN;
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integer = text.slice(0, decimalIndex).replace(/[.,]/g, '');
    const decimal = text.slice(decimalIndex + 1);
    text = `${integer}.${decimal}`;
  } else if (comma >= 0) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) text = parts.join('');
    else text = `${parts.slice(0, -1).join('')}.${parts.at(-1)}`;
  } else if (text.split('.').length - 1 > 1) {
    const parts = text.split('.');
    text = `${parts.slice(0, -1).join('')}.${parts.at(-1)}`;
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return NaN;
  const v = Number(text);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}

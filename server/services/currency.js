// server/services/currency.js — all money math happens in integer
// "subunits" (1 NX = 100 subunits, same idea as cents). Never use
// JavaScript floats for balances/amounts; convert at the edges only
// (when accepting user input and when formatting for display).

const SUBUNITS_PER_NX = 100;

// Accepts a user-facing NX amount (string or number, e.g. "500", 500, "12.50")
// and returns an integer number of subunits, or null if invalid.
function toMinorUnits(nxAmount) {
  if (nxAmount === null || nxAmount === undefined) return null;
  const str = String(nxAmount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return null; // digits, optional 1-2 decimal places
  const [whole, frac = ''] = str.split('.');
  const paddedFrac = (frac + '00').slice(0, 2);
  const subunits = Number(whole) * SUBUNITS_PER_NX + Number(paddedFrac);
  if (!Number.isSafeInteger(subunits) || subunits < 0) return null;
  return subunits;
}

// Integer subunits -> integer/decimal NX (number), for internal math only.
function fromMinorUnits(subunits) {
  return subunits / SUBUNITS_PER_NX;
}

// Integer subunits -> display string, e.g. 50000 -> "500.00"
function formatCurrency(subunits) {
  const n = Number(subunits) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / SUBUNITS_PER_NX);
  const frac = String(abs % SUBUNITS_PER_NX).padStart(2, '0');
  return `${sign}${whole.toLocaleString('en-US')}.${frac}`;
}

module.exports = { SUBUNITS_PER_NX, toMinorUnits, fromMinorUnits, formatCurrency };
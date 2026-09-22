/**
 * Formatting helpers shared by notifications and API responses.
 * Prices are always quoted in USD for v1.
 */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const usdSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8 });

/** Formats a USD price with a number of decimals that suits its magnitude. */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  const abs = Math.abs(price);
  if (abs >= 10_000) return usd0.format(price);
  if (abs >= 1) return usd2.format(price);
  if (abs >= 0.01) return usd4.format(price);
  return usdSmall.format(price);
}

/** Formats a percentage with an explicit sign, e.g. "+2.5%" or "-0.75%". */
export function formatPercent(percent: number, digits = 2): string {
  if (!Number.isFinite(percent)) return '—';
  const rounded = Number(percent.toFixed(digits));
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}%`;
}

/** Human readable duration for windows and cooldowns, e.g. "90 min", "4 h", "2 d". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${(minutes / 60).toFixed(1)} h`;
}

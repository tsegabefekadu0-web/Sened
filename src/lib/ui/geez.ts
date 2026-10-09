const ONES = ["", "፩", "፪", "፫", "፬", "፭", "፮", "፯", "፰", "፱"];
const TENS = ["", "፲", "፳", "፴", "፵", "፶", "፷", "፸", "፹", "፺"];

/** Ge'ez numerals for 1..99 (dates, round numbers). Other values fall back to Latin digits. */
export function geez(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  return `${TENS[Math.floor(n / 10)]}${ONES[n % 10]}`;
}

export const ETHIOPIC_MONTHS = [
  "መስከረም", "ጥቅምት", "ኅዳር", "ታኅሣሥ", "ጥር", "የካቲት", "መጋቢት", "ሚያዝያ", "ግንቦት", "ሰኔ", "ሐምሌ", "ነሐሴ", "ጳጉሜ"
] as const;

export const ETHIOPIC_MONTHS_EN = [
  "Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit", "Megabit", "Miazia", "Ginbot", "Sene", "Hamle", "Nehase", "Pagume"
] as const;

export interface EthiopicDate {
  readonly year: number;
  /** 0-based index into ETHIOPIC_MONTHS (12 = Pagume). */
  readonly month: number;
  readonly day: number;
}

/** Gregorian date to the Ethiopian calendar (via Julian day number). */
export function toEthiopic(date: Date): EthiopicDate {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  const jdn = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  const r = (jdn - 1723856) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((jdn - 1723856) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  return { year, month: Math.floor(n / 30), day: (n % 30) + 1 };
}

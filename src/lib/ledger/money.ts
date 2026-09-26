import { LedgerError } from "./errors";

export const ETB_DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;
export const WIRE_ETB_DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,17})\.\d{2}$/;
export const MAX_ETB_MINOR_UNITS = 9_999_999_999_999_999_999n;

export function toEtbMinorUnits(value: string, positive = false): bigint {
  if (!ETB_DECIMAL_PATTERN.test(value)) {
    throw new LedgerError("INVALID_AMOUNT", "Invalid ETB amount");
  }

  const [whole, fraction = ""] = value.split(".");
  const minorUnits = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  const maximum = BigInt(whole) * 100n + 99n;

  if (minorUnits > MAX_ETB_MINOR_UNITS || maximum > MAX_ETB_MINOR_UNITS) {
    throw new LedgerError("INVALID_AMOUNT", "ETB amount is outside numeric(20,2)");
  }

  if (positive && minorUnits === 0n) {
    throw new LedgerError("INVALID_AMOUNT", "Ledger posting amount must be positive");
  }

  return minorUnits;
}

export function isEtbAmount(value: string, positive = false): boolean {
  try {
    toEtbMinorUnits(value, positive);
    return true;
  } catch {
    return false;
  }
}

export function assertEtbAmount(value: string, positive = false): string {
  toEtbMinorUnits(value, positive);
  return value;
}

function assertMinorUnits(value: bigint): bigint {
  if (value < 0n) {
    throw new LedgerError("INVALID_AMOUNT", "ETB result cannot be negative");
  }
  if (value > MAX_ETB_MINOR_UNITS) {
    throw new LedgerError("INVALID_AMOUNT", "ETB result is outside numeric(20,2)");
  }
  return value;
}

export function formatEtbMinorUnits(value: bigint): string {
  assertMinorUnits(value);
  const whole = value / 100n;
  const fraction = value % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

export function formatEtbAmount(value: string): string {
  return formatEtbMinorUnits(toEtbMinorUnits(value));
}

export function formatEtbDisplay(value: string): string {
  const canonical = formatEtbAmount(value);
  const [whole, fraction] = canonical.split(".");
  return `Br ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

export function addEtbAmounts(...values: readonly string[]): string {
  return formatEtbMinorUnits(
    values.reduce((total, value) => total + toEtbMinorUnits(value), 0n)
  );
}

export function subtractEtbAmounts(minuend: string, subtrahend: string): string {
  return formatEtbMinorUnits(toEtbMinorUnits(minuend) - toEtbMinorUnits(subtrahend));
}

export function compareEtbAmounts(left: string, right: string): -1 | 0 | 1 {
  const leftMinor = toEtbMinorUnits(left);
  const rightMinor = toEtbMinorUnits(right);
  return leftMinor < rightMinor ? -1 : leftMinor > rightMinor ? 1 : 0;
}

export function sumEtbAmounts(values: Iterable<string>): string {
  let total = 0n;
  for (const value of values) {
    total += toEtbMinorUnits(value);
  }
  return formatEtbMinorUnits(total);
}

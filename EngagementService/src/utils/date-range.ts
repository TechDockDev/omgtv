const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayStartUtc(dateStr: string): Date {
  // dateStr = YYYY-MM-DD. Midnight IST = 18:30 UTC the previous day.
  const utcMidnight = new Date(`${dateStr}T00:00:00.000Z`);
  return new Date(utcMidnight.getTime() - IST_OFFSET_MS);
}

/**
 * Resolves an inclusive IST calendar-day range [start, end) into UTC instants
 * for Prisma date filtering. Defaults to the trailing 30 days when omitted.
 */
export function resolveIstDateRange(startDate?: string, endDate?: string): { start: Date; end: Date } {
  const end = endDate ? new Date(istDayStartUtc(endDate).getTime() + 24 * 60 * 60 * 1000) : new Date();
  const start = startDate ? istDayStartUtc(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function formatHoursMinutes(totalSeconds: number): string {
  const totalMinutes = Math.round(Math.max(0, totalSeconds) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

/** Formats an instant as ISO-8601 in IST, e.g. 2026-10-01T14:32:10+05:30. */
export function toIstIso(date: Date): string {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+05:30`;
}

export interface LondonDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsFor(date: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
}

export function getLondonDateParts(date: Date): LondonDateParts {
  const parts = partsFor(date);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function formatLondonDate(date: Date): string {
  const p = getLondonDateParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatLondonTime(date: Date): string {
  const p = getLondonDateParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function getLondonWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
  })
    .format(date)
    .toLowerCase();
}

export function getIsoOffset(iso: string): string {
  const match = iso.match(/([+-]\d{2}:\d{2}|Z)$/);
  if (!match) return "+00:00";
  return match[1] === "Z" ? "+00:00" : match[1];
}

export function withLondonWallTime(existingIso: string, time: string): string {
  return `${formatLondonDate(new Date(existingIso))}T${time}:00${getIsoOffset(existingIso)}`;
}

/** GUI formatting only. Persisted timestamps and CLI JSON remain ISO 8601. */
export function formatDisplayDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatElapsedTime(
  value: string,
  nowMs = Date.now(),
): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs) return null;
  const seconds = Math.floor((nowMs - parsed) / 1_000);
  for (const [size, unit] of [
    [365 * 86400, "y"],
    [30 * 86400, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const) {
    if (seconds >= size || unit === "s")
      return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return null;
}

export function formatEventDateTime(value: string, nowMs = Date.now()): string {
  const absolute = formatDisplayDateTime(value);
  const elapsed = formatElapsedTime(value, nowMs);
  return elapsed ? `${absolute} (${elapsed})` : absolute;
}

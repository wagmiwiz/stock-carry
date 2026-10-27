// NYSE full-day closures and 1:00 pm ET early closes, 2026-2028 (NYSE Group release, 2025-12-23).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);
const ENTER_AFTER_OPEN_MIN = 5;
const EXIT_BEFORE_CLOSE_MIN = 30;

// Minutes east of UTC for New York at instant t.
function nyOffsetMin(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(new Date(t));
  const name = parts.find((part) => part.type === "timeZoneName")!.value; // "GMT-04:00"
  const [, sign, hh, mm] = name.match(/GMT([+-])(\d\d):(\d\d)/)!;
  return (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
}

// True from 5 minutes after the week's first US session opens until 30 minutes before its last session closes.
export function inTradingWeek(now: number): boolean {
  const offset = nyOffsetMin(now);
  const local = new Date(now + offset * 60_000); // wall clock in New York, read through UTC getters
  if (local.getUTCFullYear() > 2028) throw new Error("US market calendar ends in 2028: extend HOLIDAYS and EARLY_CLOSES.");
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const sessions = [0, 1, 2, 3, 4]
    .map((i) => new Date(monday + i * 86_400_000).toISOString().slice(0, 10))
    .filter((day) => !HOLIDAYS.has(day));
  if (sessions.length === 0) return false;
  const first = sessions[0]!;
  const last = sessions[sessions.length - 1]!;
  const wall = (day: string, minutes: number) => Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  const opensAt = wall(first, 9 * 60 + 30 + ENTER_AFTER_OPEN_MIN);
  const closesAt = wall(last, (EARLY_CLOSES.has(last) ? 13 * 60 : 16 * 60) - EXIT_BEFORE_CLOSE_MIN);
  return local.getTime() >= opensAt && local.getTime() < closesAt;
}

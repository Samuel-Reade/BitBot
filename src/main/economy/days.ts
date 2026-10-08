// Local days (BITBOT_SPEC.md §7.2): "day" boundaries are local time with a 4:00 AM rollover, so late-night work counts
// as the previous day. Days are 'YYYY-MM-DD' strings (§16 currentDay, lastStreakDay, dailyHistory).
//
// DST-safe: the local date and hour come from Intl in the given IANA time zone, never from "epoch minus 4 hours" (on
// the spring-forward night 4:00 AM local is only 3 real hours after midnight, on the fall-back night 5). The rollover
// compares the local wall-clock hour, so a day begins at the first instant whose local time is rolloverHour:00 or later.
// Day arithmetic is on calendar dates (UTC midnights), independent of the zone. Pure.

export const DAY_MS = 86_400_000

/** The system's IANA time zone (the default for Economy). */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The calendar date ('YYYY-MM-DD') and wall-clock hour (0–23) at epochMs in timeZone. */
export function localDateHour(epochMs: number, timeZone: string): { date: string; hour: number } {
  let y = '', m = '', d = '', h = 0
  for (const p of formatter(timeZone).formatToParts(epochMs)) {
    if (p.type === 'year') y = p.value
    else if (p.type === 'month') m = p.value
    else if (p.type === 'day') d = p.value
    else if (p.type === 'hour') h = Number(p.value) % 24
  }
  return { date: `${y}-${m}-${d}`, hour: h }
}

/** The local hour (0–23) at epochMs: the index of today's hourly bucket (§7.5). */
export function localHour(epochMs: number, timeZone: string): number {
  return localDateHour(epochMs, timeZone).hour
}

/** The economy day at epochMs: the local date, or the one before it while the local hour is under rolloverHour. */
export function localDay(epochMs: number, timeZone: string, rolloverHour: number): string {
  const { date, hour } = localDateHour(epochMs, timeZone)
  return hour < rolloverHour ? addDays(date, -1) : date
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value)
}

function utcMidnight(day: string): number {
  const m = DAY_RE.exec(day)
  if (!m) throw new Error(`not a day: ${day}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** The day n calendar days after day (n may be negative). */
export function addDays(day: string, n: number): string {
  return new Date(utcMidnight(day) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Calendar days from a to b (b − a): 1 for consecutive days. */
export function dayDiff(a: string, b: string): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / DAY_MS)
}

import { describe, expect, it } from 'vitest'
import { addDays, dayDiff, isDay, localDateHour, localDay, localHour } from '../src/main/economy/days'
import { tuning } from '../src/shared/tuning'

// Local days (src/main/economy/days.ts, BITBOT_SPEC.md §7.2): the 4:00 AM rollover in an IANA zone, DST-safe, and
// calendar-day arithmetic.

const R = tuning.economy.dayRolloverHour
const LA = 'America/Los_Angeles'
const utc = (iso: string): number => Date.parse(iso)

describe('localDay', () => {
  it('rolls over at 4:00 AM local: late-night work counts as the previous day', () => {
    // October: PDT (UTC−7). 03:59 local → the previous day; 04:00 → the new one.
    expect(localDay(utc('2026-10-08T10:59:59Z'), LA, R)).toBe('2026-10-07')
    expect(localDay(utc('2026-10-08T11:00:00Z'), LA, R)).toBe('2026-10-08')
    // Just after midnight still belongs to yesterday.
    expect(localDay(utc('2026-10-08T07:30:00Z'), LA, R)).toBe('2026-10-07')
    // 23:59 local is today.
    expect(localDay(utc('2026-10-09T06:59:00Z'), LA, R)).toBe('2026-10-08')
  })

  it('the rollover hour comes from the parameter', () => {
    expect(localDay(utc('2026-10-08T07:30:00Z'), LA, 0)).toBe('2026-10-08')
    // 05:59 and 06:00 PDT with a 6 AM rollover
    expect(localDay(utc('2026-10-08T12:59:00Z'), LA, 6)).toBe('2026-10-07')
    expect(localDay(utc('2026-10-08T13:00:00Z'), LA, 6)).toBe('2026-10-08')
  })

  it('DST spring-forward night (LA, 2026-03-08: 2:00 → 3:00): the day begins at 4:00 PDT, 3 real hours after midnight', () => {
    // 01:59 PST (UTC−8)
    expect(localDay(utc('2026-03-08T09:59:00Z'), LA, R)).toBe('2026-03-07')
    // 03:00 PDT (UTC−7), one real minute later: still the previous day
    expect(localDay(utc('2026-03-08T10:00:00Z'), LA, R)).toBe('2026-03-07')
    expect(localDay(utc('2026-03-08T10:59:59Z'), LA, R)).toBe('2026-03-07')
    // 04:00 PDT. "Epoch minus 4 h" would still say 2026-03-07 here (07:00Z = 23:00 PST).
    expect(localDay(utc('2026-03-08T11:00:00Z'), LA, R)).toBe('2026-03-08')
  })

  it('DST fall-back night (LA, 2026-11-01: 2:00 → 1:00): the day begins at 4:00 PST, 5 real hours after midnight', () => {
    // 01:30 PDT, then 01:30 PST an hour later: both the previous day
    expect(localDay(utc('2026-11-01T08:30:00Z'), LA, R)).toBe('2026-10-31')
    expect(localDay(utc('2026-11-01T09:30:00Z'), LA, R)).toBe('2026-10-31')
    // 03:30 PST. "Epoch minus 4 h" would say 2026-11-01 here (07:30Z = 00:30 PDT).
    expect(localDay(utc('2026-11-01T11:30:00Z'), LA, R)).toBe('2026-10-31')
    expect(localDay(utc('2026-11-01T11:59:59Z'), LA, R)).toBe('2026-10-31')
    // 04:00 PST (UTC−8)
    expect(localDay(utc('2026-11-01T12:00:00Z'), LA, R)).toBe('2026-11-01')
  })

  it('a half-hour offset zone (Asia/Kolkata, UTC+5:30): 4:00 IST is 22:30 UTC the day before', () => {
    expect(localDay(utc('2026-10-07T22:29:59Z'), 'Asia/Kolkata', R)).toBe('2026-10-07')
    expect(localDay(utc('2026-10-07T22:30:00Z'), 'Asia/Kolkata', R)).toBe('2026-10-08')
  })

  it('a half-hour offset zone with DST (Australia/Adelaide, UTC+9:30 / +10:30)', () => {
    // 2026-10-04: ACST → ACDT at 2:00. 4:00 ACDT = 17:30 UTC on 10-03.
    expect(localDay(utc('2026-10-03T17:29:00Z'), 'Australia/Adelaide', R)).toBe('2026-10-03')
    expect(localDay(utc('2026-10-03T17:30:00Z'), 'Australia/Adelaide', R)).toBe('2026-10-04')
  })

  it('UTC and year boundaries', () => {
    expect(localDay(utc('2027-01-01T03:59:00Z'), 'UTC', R)).toBe('2026-12-31')
    expect(localDay(utc('2027-01-01T04:00:00Z'), 'UTC', R)).toBe('2027-01-01')
  })
})

describe('localHour / localDateHour', () => {
  it('is the local wall-clock hour, 0–23', () => {
    expect(localHour(utc('2026-10-08T07:00:00Z'), LA)).toBe(0)
    expect(localHour(utc('2026-10-08T06:59:00Z'), LA)).toBe(23)
    expect(localHour(utc('2026-10-07T22:30:00Z'), 'Asia/Kolkata')).toBe(4)
    expect(localDateHour(utc('2026-10-08T16:00:00Z'), LA)).toEqual({ date: '2026-10-08', hour: 9 })
  })

  it('across DST: the skipped hour never appears, the repeated one twice', () => {
    expect(localHour(utc('2026-03-08T09:59:00Z'), LA)).toBe(1)
    expect(localHour(utc('2026-03-08T10:00:00Z'), LA)).toBe(3)
    expect(localHour(utc('2026-11-01T08:30:00Z'), LA)).toBe(1)
    expect(localHour(utc('2026-11-01T09:30:00Z'), LA)).toBe(1)
  })
})

describe('day arithmetic', () => {
  it('addDays across months, years and leap days', () => {
    expect(addDays('2026-10-08', 1)).toBe('2026-10-09')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2026-10-08', -60)).toBe('2026-08-09')
  })

  it('dayDiff counts calendar days (DST nights included)', () => {
    expect(dayDiff('2026-10-07', '2026-10-08')).toBe(1)
    expect(dayDiff('2026-03-07', '2026-03-09')).toBe(2)
    expect(dayDiff('2026-10-31', '2026-11-02')).toBe(2)
    expect(dayDiff('2026-10-08', '2026-10-01')).toBe(-7)
    expect(dayDiff('2026-12-31', '2027-01-01')).toBe(1)
  })

  it('isDay', () => {
    expect(isDay('2026-10-08')).toBe(true)
    expect(isDay('2026-10-8')).toBe(false)
    expect(isDay(20261008)).toBe(false)
  })
})

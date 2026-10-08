// Daily diminishing returns (BITBOT_SPEC.md §7.4). Each currency but sparks has a daily soft cap S; every credited
// event pays
//   payout = baseValue × units × multiplier × stuffedFactor,   multiplier = 1 / (1 + (earnedToday / S)²)
// with earnedToday the payout so far today, before this event (so the event itself is not discounted by its own
// size: events are small next to S, the largest is a first-ever launch, 5 treats of 25). stuffedFactor is §9.3's
// (0.5 while stuffed, else 1), supplied by M6. Sparks have no curve (§7.2 rules already rate-limit them). Pure.

/** §7.4 multiplier for the next unit after earnedToday; 1 without a soft cap (sparks). */
export function softCapMultiplier(earnedToday: number, softCap: number | null): number {
  if (softCap === null || !(softCap > 0)) return 1
  const r = Math.max(0, earnedToday) / softCap
  return 1 / (1 + r * r)
}

/** A stuffedFactor made safe to multiply by: finite, 0..1 (anything else counts as 1, not stuffed). */
export function safeStuffedFactor(f: number): number {
  return Number.isFinite(f) && f >= 0 && f <= 1 ? f : 1
}

/** The payout of one credited event of `units` worth `base` each (§7.4). */
export function payout(base: number, units: number, earnedToday: number, softCap: number | null, stuffedFactor: number): number {
  return base * units * softCapMultiplier(earnedToday, softCap) * safeStuffedFactor(stuffedFactor)
}

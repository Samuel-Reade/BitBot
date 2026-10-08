// How often bitbot-helper pushes window snapshots (BITBOT_SPEC.md §5.3, §11; decided adaptive polling, 2026-10-07 in
// docs/decisions/input-and-helper.md §6). Pure.
// - Hidden: none (nothing walks; a fresh snapshot is asked for when the pet is shown again).
// - Riding a window (standing on its top or climbing its side): tuning.world.snapshotHz.attached while that window has
//   moved within tuning.world.attachedStillS, else the normal rate (15 Hz all the time cost the helper 0.7–0.9% CPU).
// - Otherwise: the normal rate. (Asleep, 1 Hz, comes with sleeping in M6.)

export interface SnapshotRateInput {
  /** The pet is hidden (by the user or macOS). */
  hidden: boolean
  /** The pet stands on or climbs a window. */
  riding: boolean
  /** Seconds since the ridden window last moved (Infinity: not since the pet got on). */
  sinceRideMovedS: number
}

/** tuning.world satisfies this. */
export interface SnapshotRateTuning {
  snapshotHz: { normal: number; attached: number; asleep: number }
  attachedStillS: number
}

export function snapshotHz(input: SnapshotRateInput, t: SnapshotRateTuning): number {
  if (input.hidden) return 0
  if (input.riding && input.sinceRideMovedS < t.attachedStillS) return t.snapshotHz.attached
  return t.snapshotHz.normal
}

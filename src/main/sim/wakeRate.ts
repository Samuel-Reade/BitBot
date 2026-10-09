// How often the simulation wakes (M9, BITBOT_SPEC.md §11: < 3% CPU roaming, < 1% asleep). Pure.
// Every wake costs main a timer, a cursor read and the hooks, so while nothing can change quickly the loop wakes only
// every few steps (SimLoop.setStride; every step still runs, on the same grid, so the simulation is unchanged):
// - 1 (every step, tuning.sim.hz) whenever anything moves or may start to: the pet moves, falls, lands or is held; a
//   route or a pending send; the cursor is near the pet (the grab area must follow it at full rate) or approaching it
//   (within tuning.sim.wake.approachPt of its box: the full rate starts before the cursor reaches the near zone); an
//   interaction or the summary bubble; riding a window that moves; the dev check's scripted mover.
// - tuning.sim.wake.idleStride while it idles awake (eyes still follow the cursor: the overlay shows a handful of look
//   directions, so a few updates a second look the same);
// - tuning.sim.wake.asleepStride while it sleeps (eyes closed: only the zzz, which the overlay animates itself).
// Anything that happens between wakes (a press, a command, a window snapshot that moves the pet) calls
// SimLoop.hurry(), and the next wake decides again.

import type { Box, Point } from '../../shared/geometry'

export interface WakeInput {
  /** Locomotion's behavior: anything but 'idle' moves. */
  behavior: string
  /** Locomotion has a goal (a route). */
  hasGoal: boolean
  /** A send waits for the pet to stand. */
  pendingSend: boolean
  /** PetInteraction's label: anything but 'none' (near, hover, press, drag, menu) is full rate. */
  interaction: string
  /** The cursor now and the pet's box in global pt (null: unknown → full rate). */
  cursor: Point | null
  petBox: Box | null
  /** The pet sleeps (the brain's 'sleep' activity, or the computer idle). */
  asleep: boolean
  /** Something else needs the full rate (the summary bubble, riding a moving window, a scripted mover). */
  busy: boolean
}

export interface WakeTuning {
  idleStride: number
  asleepStride: number
  approachPt: number
}

/** Distance from p to the box (0 inside). */
function distanceToBox(p: Point, b: Box): number {
  const dx = Math.max(b.left - p.x, 0, p.x - b.right)
  const dy = Math.max(b.top - p.y, 0, p.y - b.bottom)
  return Math.hypot(dx, dy)
}

/** Wake every how many steps (see the header). */
export function wakeStride(input: WakeInput, t: WakeTuning): number {
  if (input.busy || input.hasGoal || input.pendingSend) return 1
  if (input.behavior !== 'idle' || input.interaction !== 'none') return 1
  if (!input.cursor || !input.petBox || !(distanceToBox(input.cursor, input.petBox) > t.approachPt)) return 1
  return input.asleep ? t.asleepStride : t.idleStride
}

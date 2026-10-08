// The brain (BITBOT_SPEC.md §10.2 utility AI, Roam mode; §9 needs drive it): decides what the pet does by itself.
// Pure: time, needs and randomness come in; it steers Locomotion (goTo, stop) and says what the pet does in place
// (activity), which the state machine (stateMachine.ts resolveState) shows unless something more urgent is happening.
//
// Every decisionS (random in the range) while it is free (standing or holding on to a wall still, no goal being
// walked, no activity running), it scores the §10.2 goals from the needs and picks one by softmax(temperature):
//   eat             weight × hunger^needExponent (+ seeksFoodBoost once hunger ≥ seeksFoodAt), from hungryAt: to the
//                   food spot (the frontmost app's window top), then Eat for activityS.eat; no food spot: eats where it is;
//   nap             weight × (1 − energy)^needExponent, below napBelowEnergy: home (or the nearest ground), then Sleep
//                   for activityS.nap;
//   explore         weight × boredom (+ boredBoost once bored): a random place, preferring window tops it hasn't
//                   stood on lately (explore.unvisitedBias, memoryS);
//   climb           weight × boredom (+ boredBoost): the top of the nearest reachable wall or window side;
//   sit             weight (× contentSitScale when content or happy): Sit where it is (standing only), activityS.sit;
//   peek            weight × boredom (+ boredBoost): the end of a window top nearest the cursor, then Peek, activityS.peek;
//   approachCursor  weight × (boredom + lonely + boredBoost): approachCursorGapPt short of the cursor, then it idles
//                   (the overlay's eyes follow the cursor, look.ts);
//   idle            weight: stays.
// Needs are 0..100, scored as 0..1. Stuffed or sleepy (energy ≤ sleepyAt, or the sleepy mood) scale the goals that
// move it for their own sake and eat by calmScale. Unavailable goals (eat and nap before the need is felt, sit on a
// wall, nowhere to peek, movement in Stay) score 0 and are never picked: a softmax gives every candidate a chance, so a
// rested, fed pet would otherwise nap and eat every so often. After arriving, or after an activity ends, the next decision is decisionS away again:
// it never re-decides every tick.
//
// Above the utility AI, in order (each beats what follows):
//   asleep    the computer idle ≥ sleepAfterIdleMin (or asleep): home (or the nearest ground), Sleep until it clears;
//             already asleep in place, it stays put;
//   appLaunched  §10.2's strong boost: eating becomes the goal at once; it runs to the new app's window top
//             (setEatTarget, within appLaunch.windowWaitS; after that it eats where it is). Waits for a greet or an eat
//             in progress, and for a command being walked;
//   napNow    energy ≤ napAt: Sleep where it is (off a wall first) until energy is back above sleepyAt.
// greet and celebrate (§9.3) play at once wherever it is (celebrate waits for a greet or an eat to finish); asleep
// and napNow wait for them too. interrupt() (a grab, a command) drops everything; the brain then waits decisionS
// before choosing anything again.
//
// The brain only stops goals it set itself (a command the app walks the pet to is never cut short; call interrupt()
// first, then command Locomotion). An in-place activity ends when the pet is moved off its spot (flung, dropped) —
// greet and celebrate play anyway.

import { distance, type Point } from '../../../shared/geometry'
import { GOAL_KINDS, type BrainActivity, type GoalKind, type NeedLevels } from '../../../shared/life'
import type { tuning } from '../../../shared/tuning'
import type { Mood } from '../../../shared/types'
import type { PetAttach, Segment } from '../../../shared/world'
import { findRoute, placeOf, pointOf } from '../world/navigation'
import type { World } from '../world/worldModel'
import { goalAllowed, mayMove, type PetMode } from './stateMachine'
import { pickOnSegments, pickTarget } from './wander'

/** What the brain needs of Locomotion (Locomotion satisfies it). */
export interface BrainLocomotion {
  readonly state: Readonly<{ x: number; y: number; behavior: string; surface: string | null; windowId: number | null; attach: PetAttach }>
  readonly goal: Point | null
  readonly world: World
  goTo(p: Point): boolean
  stop(): void
}

export interface BrainInput {
  /** The life clock, s (scaled in dev). */
  nowS: number
  needs: NeedLevels
  mood: Mood
  stuffed: boolean
  /** energy ≤ napAt: naps where it is. */
  napNow: boolean
  /** The computer has been idle ≥ sleepAfterIdleMin (or slept): goes home (else the nearest ground) and sleeps until this clears. */
  asleep: boolean
  cursor: Point
  home: Point
  /** The top of the frontmost app's window (where "go eat" goes); null: none. */
  foodSpot: Point | null
  /** §10.3 mode (M7); default 'roam'. Stay refuses movement goals (stateMachine.ts goalAllowed). */
  mode?: PetMode
  /**
   * Hangout mode (§10.3): the spot it lives at and how far it wanders from it (tuning.brain.hangoutRadiusPt). Its
   * outings stay within the radius, it sits and sleeps at the spot (pass the spot as `home` too), and it walks back when
   * it finds itself farther away (after eating at a launched app's window, say). Null / absent: no spot.
   */
  hangout?: { centre: Point; radiusPt: number } | null
}

type BrainParams = typeof tuning.brain
type NeedsParams = typeof tuning.needs

/** Why it sleeps: the computer is idle, it can't keep its eyes open (napNow), or it chose to (nap). */
type SleepKind = 'asleep' | 'napNow' | 'nap'

/** An activity in progress. */
interface Doing {
  activity: BrainActivity
  /** When it ends by itself, life-clock s; null: when its condition ends (sleep). */
  untilS: number | null
  sleep: SleepKind | null
}

/** Somewhere the brain is walking the pet, and what it does there. */
interface Errand {
  goal: GoalKind
  then: 'eat' | 'sit' | 'peek' | 'sleep' | null
  sleep: SleepKind | null
  /** The app launch this walk runs to eat for; null: not a launch. */
  launch: Launch | null
}

interface Launch {
  startS: number
  target: Point | null
  /** An errand to `target` is under way. */
  going: boolean
}

/** Behaviors in which the brain can steer the pet (else it waits: held, in the air, landing). */
const STEERABLE = new Set(['idle', 'walk', 'run', 'climb'])
/** Activities that play wherever the pet is (moving it doesn't end them). */
const ANYWHERE: ReadonlySet<BrainActivity> = new Set<BrainActivity>(['greet', 'celebrate'])

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class Brain {
  private doing: Doing | null = null
  private errand: Errand | null = null
  /** The pet's current Locomotion goal is the brain's (an errand's). */
  private ownsGoal = false
  /** Stop the brain's own goal at the next tick (greet / celebrate / a launch came without a Locomotion). */
  private stopOwn = false
  private launch: Launch | null = null
  private celebrateNext = false
  private nextDecisionS: number | null = null
  /** interrupt(): asleep, napNow and decisions wait until then. */
  private waitUntilS = Number.NEGATIVE_INFINITY
  private interrupted = false
  private lastGoal: GoalKind | null = null
  private lastScores: Record<GoalKind, number> | null = null
  /** Window ids it stood on, and when last (explore prefers the others). */
  private readonly visited = new Map<number, number>()

  constructor(
    private readonly params: BrainParams,
    private readonly needs: NeedsParams,
    private readonly random: () => number,
  ) {}

  /** What the pet does in place; null: nothing (moving, or idling). */
  get activity(): BrainActivity | null {
    return this.doing?.activity ?? null
  }

  /** The goal chosen last (also an app launch's eat, asleep's nap); null before the first. */
  get goalKind(): GoalKind | null {
    return this.lastGoal
  }

  /** The scores at the last decision (§10.2), unavailable goals 0; null before the first. */
  get scores(): Record<GoalKind, number> | null {
    return this.lastScores
  }

  /** §10.2 app launch: run to eat now. target: the new app's window top, or null until it appears (setEatTarget). */
  appLaunched(nowS: number, target: Point | null): void {
    this.launch = { startS: nowS, target: target ? { x: target.x, y: target.y } : null, going: false }
    this.lastGoal = 'eat'
  }

  /** The launched app's window appeared (ignored when no launch is waiting: it already ate). */
  setEatTarget(target: Point): void {
    if (!this.launch) return
    this.launch.target = { x: target.x, y: target.y }
    this.launch.going = false
  }

  /** Welcome back / after waking (§9.3): Greet for activityS.greet, wherever it is, then carries on. */
  greet(nowS: number): void {
    this.startAnywhere('greet', nowS + this.params.activityS.greet)
  }

  /** The return after neglect (§9.3): Celebrate for activityS.celebrate, after a greet or an eat in progress. */
  celebrate(nowS: number): void {
    const a = this.doing?.activity
    if (a === 'greet' || a === 'eat') {
      this.celebrateNext = true
      return
    }
    this.startAnywhere('celebrate', nowS + this.params.activityS.celebrate)
  }

  /**
   * The user grabbed the pet, or commanded it (Come here, Go home, ⌥⌘-click): the activity, the goal and a pending
   * app launch are dropped (its Locomotion goal is left alone: the command replaces it, a grab clears it). The brain
   * then waits decisionS before choosing again.
   */
  interrupt(): void {
    this.doing = null
    this.errand = null
    this.ownsGoal = false
    this.stopOwn = false
    this.launch = null
    this.celebrateNext = false
    this.nextDecisionS = null
    this.interrupted = true
  }

  /** Every simulation tick, before Locomotion steps. */
  tick(input: BrainInput, loco: BrainLocomotion): void {
    const now = input.nowS
    const s = loco.state
    if (this.interrupted) {
      this.interrupted = false
      this.waitUntilS = now + this.decisionDelayS()
    }
    if (this.stopOwn) {
      this.stopOwn = false
      if (this.ownsGoal && loco.goal !== null) loco.stop()
      this.ownsGoal = false
    }
    if (s.behavior === 'held') {
      // Grabbed: Locomotion dropped the goal.
      this.errand = null
      this.ownsGoal = false
    }
    if (s.windowId !== null && s.behavior === 'idle') this.visited.set(s.windowId, now)

    this.updateDoing(input, s.behavior)

    // Asleep cleared on the way home: stay where it is.
    if (!input.asleep && this.errand?.sleep === 'asleep') this.dropErrand(loco)

    // Arrived (or got as near as it can).
    if (this.errand && loco.goal === null && s.behavior === 'idle') this.arrive(now, input)

    const steerable = STEERABLE.has(s.behavior)
    // §10.1: greet and eat outrank everything the brain does; celebrate is short, let it end too.
    const mustFinish = this.doing !== null && (ANYWHERE.has(this.doing.activity) || this.doing.activity === 'eat')
    const foreignGoal = loco.goal !== null && !this.ownsGoal
    const waiting = now < this.waitUntilS

    // The computer is idle: sleep (home first).
    if (input.asleep && !waiting) {
      if (mustFinish) return
      if (this.doing?.activity === 'sleep') {
        this.doing.sleep = 'asleep'
        this.doing.untilS = null
        return
      }
      if (this.errand?.sleep === 'asleep') return
      if (!steerable || foreignGoal) return
      this.goSleep('asleep', input, loco)
      return
    }

    // An app launched: run to eat.
    if (this.launch) {
      if (mustFinish) return
      if (this.errand?.launch === this.launch && this.launch.going) return
      if (!steerable || foreignGoal) return
      this.handleLaunch(input, loco)
      return
    }

    // Too tired to go on: nap where it is.
    if (input.napNow && !waiting) {
      if (mustFinish || this.doing?.activity === 'sleep') return
      if (this.errand?.then === 'sleep') return
      if (!steerable || foreignGoal) return
      this.dropDoing()
      this.dropErrand(loco)
      this.lastGoal = 'nap'
      if (s.attach === 'floor') this.startDoing(now, 'sleep', 'napNow')
      else this.goThen(loco, input, 'nap', this.groundBelow(loco), 'sleep', 'napNow')
      return
    }

    if (this.errand || this.doing) return

    // Free: decide every decisionS.
    if (s.behavior !== 'idle' || loco.goal !== null || waiting) {
      this.nextDecisionS = null
      return
    }
    if (this.nextDecisionS === null) {
      this.nextDecisionS = now + this.decisionDelayS()
      return
    }
    if (now < this.nextDecisionS) return
    this.nextDecisionS = null
    this.decide(input, loco)
  }

  // ───────────────────────────── deciding ─────────────────────────────

  private decide(input: BrainInput, loco: BrainLocomotion): void {
    const mode = input.mode ?? 'roam'
    // Hangout: away from the spot (an errand, a toss, the spot moved with its app's window): back to it first, to sit.
    const h = mode === 'hangout' ? input.hangout : null
    if (h && distance(here(loco), h.centre) > h.radiusPt) {
      this.lastGoal = 'sit'
      if (this.goThen(loco, input, 'sit', h.centre, 'sit', null)) return
    }
    const { scores, available } = this.score(input, loco, mode)
    this.lastScores = scores
    const goal = this.pick(scores, available)
    this.lastGoal = goal
    this.act(goal, input, loco, mode)
  }

  /** §10.2 scores (see the file comment). */
  private score(input: BrainInput, loco: BrainLocomotion, mode: PetMode): { scores: Record<GoalKind, number>; available: Set<GoalKind> } {
    const p = this.params
    const w = p.weights
    const n = this.needs
    const level = (v: number): number => clamp(v / 100, 0, 1)
    const hunger = level(input.needs.hunger)
    const tired = 1 - level(input.needs.energy)
    const boredom = level(input.needs.boredom)
    const bored = input.needs.boredom >= n.boredom.boredAt ? p.boredBoost : 0
    const lonely = input.mood === 'lonely' || input.needs.dust >= n.dust.lonelyAt ? 1 : 0
    const content = input.mood === 'content' || input.mood === 'happy'
    const sleepy = input.needs.energy <= n.energy.sleepyAt || input.mood === 'sleepy'
    const calm = input.stuffed || sleepy ? p.calmScale : 1

    const raw: Record<GoalKind, number> = {
      eat: w.eat * (hunger ** p.needExponent + (input.needs.hunger >= n.hunger.seeksFoodAt ? p.seeksFoodBoost : 0)) * calm,
      nap: w.nap * tired ** p.needExponent,
      explore: w.explore * (boredom + bored) * calm,
      climb: w.climb * (boredom + bored) * calm,
      sit: w.sit * (content ? p.contentSitScale : 1),
      peek: w.peek * (boredom + bored) * calm,
      approachCursor: w.approachCursor * (boredom + lonely + bored) * calm,
      idle: w.idle,
    }
    const onWall = loco.state.attach !== 'floor'
    const available = new Set<GoalKind>()
    const scores = {} as Record<GoalKind, number>
    for (const g of GOAL_KINDS) {
      const ok =
        goalAllowed(g, mode) &&
        !(g === 'eat' && input.needs.hunger < n.hunger.hungryAt) &&
        !(g === 'nap' && input.needs.energy >= p.napBelowEnergy) &&
        !(g === 'sit' && onWall) &&
        !(g === 'peek' && windowTops(loco.world).length === 0)
      if (ok) available.add(g)
      scores[g] = ok ? raw[g] : 0
    }
    return { scores, available }
  }

  /** Softmax with temperature over the available goals (one draw of random); 'idle' when none. */
  private pick(scores: Record<GoalKind, number>, available: Set<GoalKind>): GoalKind {
    const goals = GOAL_KINDS.filter((g) => available.has(g))
    if (goals.length === 0) return 'idle'
    const t = this.params.temperature
    const max = Math.max(...goals.map((g) => scores[g]))
    if (!(t > 0)) return goals.find((g) => scores[g] === max) as GoalKind
    const weights = goals.map((g) => Math.exp((scores[g] - max) / t))
    const total = weights.reduce((a, b) => a + b, 0)
    let u = clamp(this.random(), 0, 1) * total
    for (let i = 0; i < goals.length; i++) {
      u -= weights[i] as number
      if (u < 0) return goals[i] as GoalKind
    }
    return goals[goals.length - 1] as GoalKind
  }

  private act(goal: GoalKind, input: BrainInput, loco: BrainLocomotion, mode: PetMode): void {
    const now = input.nowS
    const move = mayMove(mode)
    const h = mode === 'hangout' ? (input.hangout ?? null) : null
    /** In Hangout, a target farther than the radius from the spot becomes one within it (null: none there). */
    const near = (target: Point | null): Point | null => (h ? keepNear(target, h, loco.world, this.random) : target)
    switch (goal) {
      case 'idle':
        return
      case 'sit':
        // Hangout: it sits at its spot (§10.3 "returns there to sit/sleep").
        if (h && distance(here(loco), h.centre) > this.params.hangoutSitPt && this.goThen(loco, input, 'sit', h.centre, 'sit', null)) return
        this.startDoing(now, 'sit', null)
        return
      case 'eat':
        if (move && input.foodSpot) this.goThen(loco, input, 'eat', input.foodSpot, 'eat', null)
        else this.startDoing(now, 'eat', null)
        return
      case 'nap':
        this.goSleep('nap', input, loco)
        return
      case 'explore':
        this.goThen(loco, input, 'explore', near(this.exploreTarget(now, loco)), null, null)
        return
      case 'climb':
        this.goThen(loco, input, 'climb', near(pickTarget('wall', loco.world, here(loco), this.random)), null, null)
        return
      case 'peek':
        this.goThen(loco, input, 'peek', near(peekTarget(loco.world, input.cursor)), 'peek', null)
        return
      case 'approachCursor':
        this.goThen(loco, input, 'approachCursor', near(this.approachTarget(loco, input.cursor)), null, null)
        return
    }
  }

  // ───────────────────────────── targets ─────────────────────────────

  /** A window top not stood on within explore.memoryS (with unvisitedBias, when there is one), else anywhere. */
  private exploreTarget(now: number, loco: BrainLocomotion): Point | null {
    const e = this.params.explore
    for (const [id, at] of this.visited) if (now - at > e.memoryS) this.visited.delete(id)
    const world = loco.world
    const from = here(loco)
    const minD = this.params.wander.minDistancePt
    const unvisited = windowTops(world).filter((s) => s.windowId !== null && !this.visited.has(s.windowId))
    if (unvisited.length > 0 && this.random() < e.unvisitedBias) {
      const p = pickOnSegments(unvisited, from, this.random, minD, world.params.occlusionTolerance)
      if (p) return p
    }
    return pickTarget('any', world, from, this.random, minD)
  }

  /** approachCursorGapPt short of the reachable place nearest the cursor, on the pet's side of it. */
  private approachTarget(loco: BrainLocomotion, cursor: Point): Point | null {
    const world = loco.world
    const from = placeOf(world, here(loco), world.params.occlusionTolerance)
    if (!from) return null
    const route = findRoute(world, from, cursor, world.params)
    if (!route) return null
    const end = pointOf(world, route.end)
    if (route.end.on !== 'segment') return end
    const seg = world.segment(route.end.id)
    if (!seg) return end
    const side = loco.state.x < cursor.x ? -1 : 1
    return { x: clamp(cursor.x + side * this.params.approachCursorGapPt, seg.x0, seg.x1), y: seg.y }
  }

  /** Home if it can get there, else the nearest ground (§9.3 "its bed/home spot (or the nearest ground)"). */
  private restSpot(loco: BrainLocomotion, home: Point): Point | null {
    const world = loco.world
    const from = placeOf(world, here(loco), world.params.occlusionTolerance)
    if (!from) return null
    if (findRoute(world, from, home, world.params)?.reached) return home
    return this.groundBelow(loco) ?? home
  }

  /** The ground's nearest point to the pet; null without a ground. */
  private groundBelow(loco: BrainLocomotion): Point | null {
    const g = loco.world.segments.find((s) => s.kind === 'ground')
    return g ? { x: clamp(loco.state.x, g.x0, g.x1), y: g.y } : null
  }

  // ───────────────────────────── doing ─────────────────────────────

  private handleLaunch(input: BrainInput, loco: BrainLocomotion): void {
    const l = this.launch as Launch
    const now = input.nowS
    this.dropDoing()
    this.dropErrand(loco)
    this.lastGoal = 'eat'
    if (!mayMove(input.mode ?? 'roam')) {
      this.launch = null
      this.startDoing(now, 'eat', null)
      return
    }
    if (l.target) {
      l.going = true
      if (this.goThen(loco, input, 'eat', l.target, 'eat', null)) {
        ;(this.errand as Errand).launch = l
      } else {
        this.launch = null
      }
      return
    }
    // No window yet: wait for it (standing still), then eat where it is.
    if (now - l.startS >= this.params.appLaunch.windowWaitS) {
      this.launch = null
      this.startDoing(now, 'eat', null)
    }
  }

  /** To the rest spot (in place in Stay, or when it can't plan), then Sleep. */
  private goSleep(kind: SleepKind, input: BrainInput, loco: BrainLocomotion): void {
    this.dropDoing()
    this.dropErrand(loco)
    this.lastGoal = 'nap'
    const target = mayMove(input.mode ?? 'roam') ? this.restSpot(loco, input.home) : null
    this.goThen(loco, input, 'nap', target, 'sleep', kind)
  }

  /**
   * Walks to `target`, then `then`. No target, or Locomotion can't plan: eat and sleep happen where it is, the rest is
   * dropped. Returns whether an errand started.
   */
  private goThen(
    loco: BrainLocomotion,
    input: BrainInput,
    goal: GoalKind,
    target: Point | null,
    then: Errand['then'],
    sleep: SleepKind | null,
  ): boolean {
    if (target && loco.goTo(target)) {
      this.errand = { goal, then, sleep, launch: null }
      this.ownsGoal = loco.goal !== null
      return true
    }
    if (then === 'eat' || then === 'sleep') this.startDoing(input.nowS, then, sleep)
    return false
  }

  private arrive(now: number, input: BrainInput): void {
    const e = this.errand as Errand
    this.errand = null
    this.ownsGoal = false
    if (e.launch !== null && e.launch === this.launch) this.launch = null
    if (e.then === 'sleep' && e.sleep === 'asleep' && !input.asleep) return
    if (e.then !== null) this.startDoing(now, e.then, e.sleep)
  }

  private startDoing(now: number, activity: BrainActivity, sleep: SleepKind | null): void {
    const a = this.params.activityS
    let untilS: number | null
    switch (activity) {
      case 'eat':
        untilS = now + a.eat
        break
      case 'sit':
        untilS = now + this.inRange(a.sit)
        break
      case 'peek':
        untilS = now + this.inRange(a.peek)
        break
      case 'sleep':
        untilS = sleep === 'nap' ? now + this.inRange(a.nap) : null
        break
      case 'greet':
        untilS = now + a.greet
        break
      case 'celebrate':
        untilS = now + a.celebrate
        break
    }
    this.doing = { activity, untilS, sleep }
  }

  /** greet / celebrate: now, wherever it is; the brain's own walk stops at the next tick. */
  private startAnywhere(activity: 'greet' | 'celebrate', untilS: number): void {
    if (this.errand) {
      this.errand = null
      this.stopOwn = true
    }
    if (this.launch) this.launch.going = false
    this.doing = { activity, untilS, sleep: null }
  }

  /** Ends the activity when its time or its condition is up (or the pet was moved off its spot). */
  private updateDoing(input: BrainInput, behavior: string): void {
    const d = this.doing
    if (!d) return
    const now = input.nowS
    if (behavior !== 'idle' && !ANYWHERE.has(d.activity)) {
      this.endDoing(now)
      return
    }
    if (d.activity === 'sleep') {
      // Asleep beats napNow beats a chosen nap; it sleeps on while any of them holds.
      const recovered = input.needs.energy > this.needs.energy.sleepyAt
      const still: SleepKind | null = input.asleep
        ? 'asleep'
        : input.napNow || (d.sleep === 'napNow' && !recovered)
          ? 'napNow'
          : d.sleep === 'nap' && d.untilS !== null && now < d.untilS
            ? 'nap'
            : null
      if (still === null) this.endDoing(now)
      else if (still !== d.sleep) {
        d.sleep = still
        d.untilS = null
      }
      return
    }
    if (d.untilS !== null && now >= d.untilS) this.endDoing(now)
  }

  private endDoing(now: number): void {
    const ended = this.doing?.activity
    this.doing = null
    if (this.celebrateNext && (ended === 'greet' || ended === 'eat')) {
      this.celebrateNext = false
      this.doing = { activity: 'celebrate', untilS: now + this.params.activityS.celebrate, sleep: null }
    }
  }

  private dropDoing(): void {
    this.doing = null
  }

  private dropErrand(loco: BrainLocomotion): void {
    if (this.ownsGoal && loco.goal !== null) loco.stop()
    this.errand = null
    this.ownsGoal = false
  }

  private decisionDelayS(): number {
    return this.inRange(this.params.decisionS)
  }

  private inRange(r: readonly [number, number]): number {
    return r[0] + clamp(this.random(), 0, 1) * (r[1] - r[0])
  }
}

// SPEC-DEVIATION: §10.3 measures the hangout range "along connected surfaces"; this uses the straight-line distance
// from the spot, which is close enough for a ~300 pt range and needs no route search per candidate. A target across a
// gap still has to be reachable (Locomotion goes to the nearest reachable place).
/**
 * `target` if it is within the hangout radius of the spot, else a random point on the surfaces within it (the parts of
 * segments inside the radius box around the spot); null when there are none.
 */
function keepNear(target: Point | null, h: { centre: Point; radiusPt: number }, world: World, random: () => number): Point | null {
  if (target && distance(target, h.centre) <= h.radiusPt) return target
  const c = h.centre
  const r = h.radiusPt
  const pieces: Segment[] = []
  for (const seg of world.segments) {
    if (Math.abs(seg.y - c.y) > r) continue
    const x0 = Math.max(seg.x0, c.x - r)
    const x1 = Math.min(seg.x1, c.x + r)
    if (x1 > x0) pieces.push({ ...seg, x0, x1 })
  }
  if (pieces.length === 0) return null
  const p = pickOnSegments(pieces, c, random, 0, world.params.occlusionTolerance)
  return p && distance(p, c) <= r ? p : null
}

function here(loco: BrainLocomotion): Point {
  return { x: loco.state.x, y: loco.state.y }
}

function windowTops(world: World): Segment[] {
  return world.segments.filter((s) => s.kind === 'windowTop')
}

/** The end of a window top nearest the cursor (where the pet peeks out from behind its edge); null without any. */
function peekTarget(world: World, cursor: Point): Point | null {
  let best: Point | null = null
  for (const s of windowTops(world)) {
    for (const x of [s.x0, s.x1]) {
      const p = { x, y: s.y }
      if (best === null || distance(p, cursor) < distance(best, cursor)) best = p
    }
  }
  return best
}

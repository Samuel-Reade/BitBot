// The pet's inner life as the running app keeps it (BITBOT_SPEC.md §9 needs, mood and the healthy rhythm; §10.1–§10.2
// the brain and the state machine). Pure (no Electron): BitbotApp feeds it; unit-tested with fakes in
// test/petLife.test.ts.
// - The needs (sim/needs/) advance on the life clock (lifeClock.ts: real time × the dev time scale) at
//   tuning.needs.hiddenTickHz, shown or hidden (§8.6 "the simulation continues at low rate"); every payout's
//   nutrition feeds them; the computer's sleep applies in one step on resume (capped by the needs model).
// - Asleep (§9.3): the computer idle sleepAfterIdleMin, or the Mac asleep. On the return: a stretch and a yawn
//   (reaction 'wakeUp'), then a greeting.
// - The brain (sim/brain/brain.ts) chooses what the pet does while it is shown and acts by itself; the user's commands
//   and grabs interrupt it; an app launch sends it running to the new app's window to eat (§10.2).
// - Interactions (pet, drag, command, app launch) lower boredom; the first after a dusty return shakes the dust off
//   (reaction 'shakeOff', §9.1). The economy's welcome back and return after neglect greet and celebrate (§7.2, §9.3).
// - The state pet:state shows: stateMachine.ts resolveState (§10.1 priorities).

import type { EconomyEvent } from './economy/economy'
import type { Point } from '../shared/geometry'
import type { PetMode } from '../shared/modes'
import type { BrainActivity, GoalKind, LifeSnapshot, TimeScale } from '../shared/life'
import type { BehaviorState, Mood, PetReactionKind } from '../shared/types'
import { tuning } from '../shared/tuning'
import type { Brain, BrainLocomotion } from './sim/brain/brain'
import { resolveState } from './sim/brain/stateMachine'
import type { LifeClock } from './sim/lifeClock'
import type { LocomotionBehavior } from './sim/locomotion/locomotion'
import type { Needs } from './sim/needs/needs'

export type InteractionKind = 'pet' | 'drag' | 'command' | 'appLaunch'

export interface PetLifeDeps {
  clock: LifeClock
  needs: Needs
  brain: Brain
  /** The economy's lifetime nutrition (each payout's growth feeds the needs) and its local day (dust, §9.1). */
  nutritionLifetime(): number
  dayKey(): string
  /** Seconds since the user's last input, system-wide. */
  systemIdleS(): number
  /** Wall clock, ms (how long the Mac slept). */
  wallNowMs(): number
  /** A reaction pet:state carries (the overlay plays it once). */
  react(kind: PetReactionKind): void
}

export class PetLife {
  private lastLifeS: number
  private lastNutrition: number
  private asleepByIdle = false
  /** Between the Mac's 'suspend' and 'resume': wall ms when it went to sleep. */
  private sleptAtMs: number | null = null
  private greetAtS: number | null = null
  private lastGreetS = Number.NEGATIVE_INFINITY
  /** An app launch waiting for its window (§10.2): which app, and until when (life s). */
  private launch: { bundleId: string; untilS: number } | null = null

  constructor(private readonly deps: PetLifeDeps) {
    this.lastLifeS = deps.clock.now()
    this.lastNutrition = deps.nutritionLifetime()
  }

  /** The pet sleeps (§9.3): the computer idle long enough, or the Mac asleep. */
  get asleep(): boolean {
    return this.asleepByIdle || this.sleptAtMs !== null
  }

  get stuffed(): boolean {
    return this.deps.needs.stuffed
  }

  /** The needs' mood now (§9.2). */
  mood(): Mood {
    return this.deps.needs.mood(this.deps.clock.now())
  }

  /** The dust level for pet:state, 0..1. */
  get dust(): number {
    return this.deps.needs.levels.dust / 100
  }

  get activity(): BrainActivity | null {
    return this.deps.brain.activity
  }

  /** The life tick (tuning.needs.hiddenTickHz): the needs, sleep and waking, nutrition. */
  advance(): void {
    const d = this.deps
    const now = d.clock.now()
    const dt = Math.max(0, now - this.lastLifeS)
    this.lastLifeS = now
    const idleS = d.systemIdleS()
    d.needs.advance(dt, now, { userIdleS: idleS, computerAsleep: false, dayKey: d.dayKey() })
    this.feedNutrition(now)
    const wasAsleep = this.asleep
    this.asleepByIdle = Number.isFinite(idleS) && idleS >= tuning.needs.sleepAfterIdleMin * 60
    if (wasAsleep && !this.asleep) this.wokeUp(now)
  }

  /** The Mac is going to sleep. */
  suspend(): void {
    if (this.sleptAtMs === null) this.sleptAtMs = this.deps.wallNowMs()
  }

  /** The Mac woke: the time it slept counts in one step (the needs cap it), then the pet wakes up and greets. */
  resume(): void {
    const sleptAt = this.sleptAtMs
    if (sleptAt === null) return
    const d = this.deps
    const now = d.clock.now()
    const sleptS = Math.max(0, (d.wallNowMs() - sleptAt) / 1000) * d.clock.scale
    d.needs.advance(sleptS, now, { userIdleS: sleptS, computerAsleep: true, dayKey: d.dayKey() })
    this.lastLifeS = now
    this.sleptAtMs = null
    this.asleepByIdle = false
    this.wokeUp(now)
  }

  /** A direct interaction (§9.1): boredom down, a dusty pet shakes it off; the user's own moves interrupt the brain. */
  interaction(kind: InteractionKind): void {
    const now = this.deps.clock.now()
    if (this.deps.needs.interaction(now).shakeOff) this.deps.react('shakeOff')
    if (kind === 'drag' || kind === 'command') this.deps.brain.interrupt()
  }

  /** The mode or the hangout spot changed (§10.3): the brain drops its plan and chooses again under the new rules. */
  modeChanged(): void {
    this.deps.brain.interrupt()
  }

  /** §10.2 an app launched: run to its window and eat (`target`: its window top, null until it appears). */
  appLaunched(bundleId: string, target: Point | null): void {
    const now = this.deps.clock.now()
    this.interaction('appLaunch')
    this.deps.brain.appLaunched(now, target)
    this.launch = target ? null : { bundleId, untilS: now + tuning.brain.appLaunch.windowWaitS }
  }

  /** The launched app waiting for its window (glue: look it up in the newest world); null when none. */
  get pendingLaunch(): string | null {
    const l = this.launch
    if (l && this.deps.clock.now() > l.untilS) this.launch = null
    return this.launch?.bundleId ?? null
  }

  /** The launched app's window appeared. */
  launchTarget(target: Point): void {
    if (!this.launch) return
    this.launch = null
    this.deps.brain.setEatTarget(target)
  }

  /** Economy events: a welcome back greets (§9.3), a return after neglect celebrates (§7.2). */
  economyEvent(e: EconomyEvent): void {
    const now = this.deps.clock.now()
    if (e.kind === 'returnAfterNeglect') this.deps.brain.celebrate(now)
    // A wake-up greets once its stretch is done: the welcome back that comes with it doesn't greet twice.
    else if (e.source === 'welcomeBack' && this.greetAtS === null) this.greet(now)
  }

  /** Each simulation wake while shown: a greeting due after a wake-up, then the brain (when it acts by itself). */
  tickBrain(
    loco: BrainLocomotion,
    extras: {
      cursor: Point
      home: Point
      foodSpot: Point | null
      enabled: boolean
      /** §10.3 (M7); absent: Roam. */
      mode?: PetMode
      hangout?: { centre: Point; radiusPt: number } | null
    },
  ): void {
    const d = this.deps
    const now = d.clock.now()
    if (this.greetAtS !== null && now >= this.greetAtS) {
      this.greetAtS = null
      this.greet(now)
    }
    if (!extras.enabled) return
    const needs = d.needs
    d.brain.tick(
      {
        nowS: now,
        needs: needs.levels,
        mood: needs.mood(now),
        stuffed: needs.stuffed,
        napNow: needs.napNow,
        asleep: this.asleep,
        cursor: extras.cursor,
        home: extras.home,
        foodSpot: extras.foodSpot,
        mode: extras.mode ?? 'roam',
        hangout: extras.hangout ?? null,
      },
      loco,
    )
  }

  /** What pet:state shows (§10.1): movement and the brain's activity by priority; the dev panel's forced state only when idle. */
  stateFor(behavior: LocomotionBehavior, forced: BehaviorState | null): BehaviorState {
    return resolveState({ behavior, activity: this.deps.brain.activity, forced })
  }

  snapshot(timeScale: TimeScale): LifeSnapshot {
    const d = this.deps
    const goal: GoalKind | null = d.brain.goalKind
    const scores = d.brain.scores
    return {
      needs: { ...d.needs.levels },
      mood: this.mood(),
      stuffed: d.needs.stuffed,
      asleep: this.asleep,
      activity: d.brain.activity,
      goal,
      scores: scores ? { ...scores } : null,
      continuousActiveMin: d.needs.continuousActiveMin,
      timeScale,
    }
  }

  private feedNutrition(now: number): void {
    const n = this.deps.nutritionLifetime()
    const gained = n - this.lastNutrition
    this.lastNutrition = n
    if (gained > 0) this.deps.needs.nutrition(gained, now)
  }

  /** Back from sleep: a stretch and a yawn, then a greeting once it has (tuning.brain.activityS.wakeUp). */
  private wokeUp(now: number): void {
    this.deps.react('wakeUp')
    this.greetAtS = now + tuning.brain.activityS.wakeUp
  }

  /** At most one greeting per return (waking and the economy's welcome back come together). */
  private greet(now: number): void {
    if (now - this.lastGreetS < tuning.brain.activityS.wakeUp + tuning.brain.activityS.greet) return
    this.lastGreetS = now
    this.deps.brain.greet(now)
  }
}

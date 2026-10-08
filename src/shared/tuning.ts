// ALL balance and behavior constants live here (BITBOT_SPEC.md §0.4, §17).
// Never hard-code a tunable number elsewhere — import it from this file.
// Sections are filled in milestone by milestone; comments say what raising/lowering feels like.

import type { IdleMode, PetSize } from './types'

export const tuning = {
  render: {
    /** On-screen height of the body box, in points, per size setting (§6). Bigger = chunkier pet. */
    bodyHeightPt: { S: 64, M: 96, L: 128 } satisfies Record<PetSize, number>,
    /** Device pixel ratio cap for the WebGL canvas. Higher = crisper but more GPU fill cost. */
    pixelRatioCap: 2,
    /** Frame-rate targets (§11). Lower = cheaper but choppier. */
    fps: { moving: 60, idle: 30, asleep: 10 },
    /** Pet viewport (approach A window / approach B canvas) edge, as a multiple of bodyHeightPt (§5.2: ~2.5×). */
    viewportScale: 2.5,
    /** Where the pet's ground-contact point sits inside the viewport, as fractions of width/height (0 = left/top). */
    anchor: { x: 0.5, y: 0.75 },
    /**
     * …while it climbs a wall on its right / left (§6.4 Climb, feet against the wall, about the contact point): the
     * turned pet reaches up to ~1.8 body heights away from the wall, so the contact point moves toward the wall's side.
     */
    climbAnchor: { wallRight: { x: 0.82, y: 0.5 }, wallLeft: { x: 0.18, y: 0.5 } },
    /** Perspective camera (§6.1). Smaller FOV = flatter, more orthographic look. */
    camera: { fovDeg: 32, heightAboveTarget: 0.5 },
    /** Default yaw toward the viewer (radians) for the 3/4 view. 0 = facing straight out of the screen. */
    defaultYaw: 0.45,
    /**
     * Lights (§6.1). Intensities are the spec's values; scene.ts multiplies them by `unitScale`
     * because three.js r155+ uses physical light units (the spec's numbers render ~2.75× too dark).
     * Raise unitScale = brighter/flatter overall; raise key vs hemisphere = more contrast between faces.
     */
    lights: {
      unitScale: 2.75,
      /**
       * true: the key and rim lights mirror left/right with the pet's facing (eased with the yaw),
       * so it looks the same walking either way. false: lights fixed to the screen as in §6.1; the
       * front of a left-facing pet is then ~28% darker and its top brighter than its front.
       */
      followFacing: true,
      hemisphere: { sky: 0xffffff, ground: 0x88aaa5, intensity: 0.75 },
      /** From upper-right-front (positions are for the default, right-facing yaw). */
      key: { color: 0xffffff, intensity: 0.9, position: [2.5, 3.5, 4] },
      /** Cool rim from back-left. */
      rim: { color: 0xbff5ee, intensity: 0.6, position: [-3, 2, -3.5] },
    },
    /** Pixel face screen (§6.3). */
    face: {
      /** How far the near-black screen background (#10201F) is tinted toward the palette's glow (0..1). */
      backgroundTint: 0.1,
      /** Darkness of the horizontal scanlines. Higher = more retro, less legible. */
      scanlineOpacity: 0.06,
      /** One scanline every N face pixels. */
      scanlinePeriodPx: 3,
      /**
       * How the face texture is sampled (see the SPEC-DEVIATION in face.ts). textureScale: the
       * 128×96 face is rasterized k× larger (each face pixel a k×k block); higher = crisper edges
       * on large pets, more memory and upload per face change (k=2: 256×192, 0.2 MB).
       * anisotropy: filtering samples along the foreshortened axis (capped by the GPU).
       * mipBias: mip level offset; more negative = sharper but starts to shimmer, 0 = soft.
       */
      sampling: { textureScale: 2, anisotropy: 8, mipBias: -0.5 },
    },
    /** Contact shadow (§6.1): black at this opacity when standing. Higher = heavier, more grounded. */
    contactShadowOpacity: 0.12,
    /**
     * Glowing parts (belly LEDs, antenna tip): fraction of their color kept as lit, shaded plastic;
     * the rest comes from the glow (tuning.anim.glow). With glow = 1 − glowAlbedo they read at their
     * hex on the lit front. Higher = more 3D shading, less "lit up"; also how they look with the glow off.
     */
    glowAlbedo: 0.25,
    /**
     * Belly LEDs (§6.1 names only "power" green-mint and amber): fixed across palettes, like a real
     * PC's lights. Lower roughness = glossier, more like a lens.
     */
    leds: { powerColor: '#6FF2B6', amberColor: '#FFB43F', roughness: 0.3 },
    /** Antenna tip roughness (§6.1 gives none; matches the body's 0.42). */
    antennaTipRoughness: 0.42,
    /**
     * Pointer hit-test forgiveness, in scene units (≈ pt ÷ 60 at size M). Bigger = easier to grab,
     * but clicks just beside the pet get caught instead of passing through.
     */
    hit: {
      /** Inflation of every collision proxy beyond the visible surface. */
      margin: 0.05,
      /** Grab sphere around the antenna tip (visible ball radius 0.1). */
      antennaTipRadius: 0.2,
      /** Grab tube along the antenna cable (visible radius 0.035). */
      antennaCableRadius: 0.08,
    },
  },

  /** Fixed-step simulation in main (§5.1). */
  sim: {
    /** Simulation rate, Hz. Higher = smoother physics and tighter dragging, more main-process wake-ups. */
    hz: 30,
    /** A wake that owes more steps than this drops the excess time instead of replaying it in a burst (after a stall or sleep). */
    maxStepsPerWake: 5,
    /**
     * Steps are computed up to this many ms before their nominal time, so main-process timer lateness below it never
     * starves the overlay, which renders one step behind real time. SPEC-DEVIATION (§5.1 computes a step once its
     * time has passed): measured in Spike A, see src/main/sim/loop.ts.
     */
    leadMs: 8,
  },

  /** The overlay renderer (approach B, docs/decisions/overlay.md). */
  overlay: {
    /** Newest simulation states kept for interpolation. */
    stateBufferSize: 8,
    /** After a drop, the pet stays drawn at the drop point until main's snap state arrives, at most this long, ms. */
    dropHoldMs: 250,
    /** A frame this many ms past the newest state counts as starved (nothing newer to interpolate toward). */
    starveToleranceMs: 0.5,
    /**
     * After a mouse event from the grab area, the overlay ignores main's cursor samples (pet:cursor) this long, ms:
     * the native events are newer. ~2 simulation steps. Higher = fewer stale re-hit-tests, slower to notice the pet
     * moving out from under a cursor that just stopped.
     */
    cursorQuietMs: 70,
    /** Dev check stats: a frame interval above this counts as long (a visible hitch at 60 Hz), ms. */
    longFrameMs: 20,
    /** Dev check stats: most samples kept per list. */
    debugSampleCap: 20_000,
    /** Contact shadow (§6.1 "fades with height"): full strength on the ground, gone at this height, pt. Higher = it lingers as the pet lifts off. */
    shadowFadePt: 24,
    /**
     * A WebGL render may start this many ms before 1000 / render.fps.moving has passed since the previous one.
     * Animation-frame timestamps sit on the display's vsync, and a "60 Hz" display refreshes slightly faster than
     * 60 Hz (16.666 ms), so a strict cap would skip every other frame there. Higher = closer to the display's own
     * rate on 75–100 Hz displays (more renders while the shadow changes); lower = a stricter cap.
     */
    renderIntervalSlackMs: 2,
    /**
     * pet:log reports per overlay page load (each distinct message is sent once). Higher = more diagnostics from a
     * faulty page, more log noise.
     */
    logMessageBudget: 50,
    /**
     * Liveness watchdog for the overlay page (a silent renderer hang is otherwise never noticed: Chromium's own hang
     * monitor needs input, and the overlay takes none). Main pings a ready page every pingMs; maxMissed pings in a row
     * without a pong recreate it (renderer killed). Lower = a frozen pet recovers sooner, more risk of recreating a page
     * that was only briefly busy.
     */
    watchdog: { pingMs: 2000, maxMissed: 3 },
    /** Display changes arrive in bursts; the overlay is re-laid out this long after the last one, ms. */
    displayChangeDebounceMs: 100,
    /**
     * A lost overlay (crashed, closed, never ready) is recreated after this long, ms; each further loss before a
     * pet:ready doubles the wait, up to recreateMaxDelayMs. Lower = the pet comes back sooner after a one-off crash.
     */
    recreateDelayMs: 1000,
    /**
     * The longest wait between recreations while the page keeps failing (e.g. WebGL unavailable), ms. Lower = recovers
     * sooner once the cause goes away, but a page that can never load costs a new window and renderer more often.
     */
    recreateMaxDelayMs: 300_000,
    /** Main gives up waiting for the overlay's first frame after this long, ms (then recreates it). */
    readyTimeoutMs: 20_000,
  },

  /**
   * The grab area (hit window): a small invisible window that takes the pet's clicks, shown only while the cursor is
   * near the pet (docs/decisions/overlay.md). Everywhere else clicks reach the apps underneath.
   */
  hitArea: {
    /** It appears when the cursor comes within this many pt of the pet's box. */
    nearMarginPt: 32,
    /** …and goes away once the cursor is farther than this, pt (> nearMarginPt, so it doesn't flicker at the edge). */
    farMarginPt: 56,
    /** Its window is the pet's box grown by this much on each side, pt. Bigger = fewer window moves while the pet moves, but a larger area a stalled app could block. */
    slackPt: 48,
    /**
     * It moves once the pet's box comes within this many pt of its edge. At least what the pet covers between two
     * simulation wakes at the fastest it moves near the cursor (600 pt/s ÷ tuning.sim.hz = 20 pt), plus a little: with
     * less, a fast pet's leading edge sticks out of the grab area until the next wake (the dev check measured 24 % of
     * wakes at 4 pt). Higher = more window moves (each costs main a few ms of CPU), lower = gaps at speed.
     */
    innerMarginPt: 24,
    /** Safety net: mouse events on but the cursor this far outside the pet's box, pt → click-through is forced back on. */
    safetyMarginPt: 8,
    /** While the cursor is near the pet, re-ask the helper this often whether the overlay is on screen (not on a fullscreen Space), ms. */
    onScreenRecheckMs: 500,
    /**
     * An on-screen question still unanswered after this long is abandoned: the overlay counts as off screen (grab area
     * hidden) and the helper is asked again, ms. Above tuning.helper.requestTimeoutMs, so a slow helper's own timeout
     * normally answers first. Lower = recovers sooner from a lost reply, but may give up on slow answers.
     */
    onScreenAnswerTimeoutMs: 3000,
    /**
     * An on-screen answer counts for this long after it was asked, ms; after that the grab area is hidden until a fresher
     * one arrives (fail closed while the helper is slow), unless a drag or the menu is in progress. Above
     * onScreenRecheckMs plus a normal reply (≈1 ms, p95 ≤ 8 ms). Lower = a stalled helper is distrusted sooner, but slow
     * replies under load make the grab area blink off (and lose hover); higher = a stale "on screen" is trusted longer.
     */
    onScreenMaxAgeMs: 800,
    /** The cursor is re-sent to the overlay for a fresh hit test when it or the pet moved more than this, pt. */
    cursorStreamMinMovePt: 0.5,
    /** A press that moves less than this is a click, not a drag: the pet is put back where it was, pt (§10.4 petting is M4). */
    clickMaxMovePt: 4,
    /**
     * After the active Space changes, the overlay may still be animating off screen: the grab area stays hidden this
     * long before the helper is asked again, ms (the spike measured the native transition at ~0.7 s).
     */
    spaceSettleMs: 700,
    /**
     * false: while the grab area is click-through, it gets no mouse moves at all; main's cursor samples (pet:cursor,
     * once per simulation step) make it clickable over the pet. true: Electron also forwards mouse moves to it
     * (clickable a step sooner), but its page then sets the cursor shape over the apps underneath (flicker; unverified).
     */
    forwardMouseMoves: false,
  },

  /** The running app's glue (src/main/bitbotApp.ts): quitting, signals, error reports and the focus self-check. */
  app: {
    /**
     * Quitting waits at most this long for bitbot-helper to exit, ms. Its own stop escalates quit → SIGTERM → SIGKILL,
     * tuning.helper.stopGraceMs apart, so this covers that with a little to spare. Lower = a faster quit that may leave
     * the helper to exit on its own (it also exits when Bitbot does).
     */
    helperStopTimeoutMs: 3500,
    /** After the clean-up, app.quit() falls back to app.exit() if the app is still running this long later, ms. */
    quitFallbackMs: 3000,
    /**
     * A repeat of the first SIGINT/SIGTERM within this many ms is the same Ctrl+C echoed by electron's cli.js (ignored);
     * a later one exits at once.
     */
    signalRepeatGraceMs: 1000,
    /**
     * An error that keeps happening (an uncaught exception in a timer, a simulation step that throws on every wake) is
     * logged once per this many ms per message, with a count of the repeats. Lower = noisier logs.
     */
    errorLogIntervalMs: 5000,
    /** Distinct throttled messages remembered (the oldest is forgotten first). */
    errorLogKeys: 100,
    /**
     * Focus self-check (activationMonitor.ts): a verdict line is printed this long after a press or a menu ends, ms.
     * Menu item clicks and activations arrive a little after the interaction ends. Lower = sooner lines, more risk of
     * missing a late activation.
     */
    activationVerdictDelayMs: 400,
    /**
     * …counting activations from this long before the interaction began, ms: AppKit would activate the app on the
     * mouse-down itself, before the overlay's 'down' reaches main.
     */
    activationLookBackMs: 400,
    /** Focus events kept for the verdicts (the oldest are dropped). */
    activationEventCap: 200,
    /**
     * Dev builds log this many of the grab area's native mouse events per press (does Electron report 'leftbuttondown'
     * during a real drag? Without it, every drag would end at its first move). 0 = off.
     */
    nativeMouseLogPerPress: 6,
  },

  move: {
    /** pt/s. Higher walk speed reads as busier/more anxious. */
    walkSpeed: 120,
    runSpeed: 320,
    climbSpeed: 70,
    /** Jump reach in pt (§8.4). */
    jump: { maxHorizontal: 220, maxUp: 160, maxDown: 600 },
    /** pt/s² and pt/s (§8.5). Higher gravity = snappier, heavier falls. */
    gravity: 2600,
    terminalVelocity: 2200,
    /** Window speed (pt/s) above which a ridden window flings the pet off. */
    flingThreshold: 1800,
    /** Movement speed multiplier while stuffed (§9.3). */
    stuffedSpeedFactor: 0.6,
    /** A pet this close above the ground (pt) counts as standing on it: released or placed there, it doesn't fall. */
    groundSnapPt: 0.5,
    /** After a fall touches down the pet is in Land (§10.1) this long before Idle, s: the squash-and-settle (§6.4). */
    landS: 0.4,
    /** A walk longer than this runs instead (§6.4 Run, runSpeed), pt. Lower = a busier pet. */
    runDistancePt: 400,
    /** A jump's arc peaks this far above the higher of its two ends, pt. Higher = loftier, slower jumps. */
    jumpApexPt: 40,
    /** §8.5 "small bounce on hard landings": a landing faster than minSpeed (pt/s) bounces back up at restitution × speed. */
    landBounce: { minSpeed: 1400, restitution: 0.18 },
  },

  world: {
    /** Helper snapshot rates in Hz (§5.3, §11). Higher = tighter window riding, more CPU. */
    snapshotHz: { normal: 4, attached: 15, asleep: 1 },
    /** Smallest window (pt) the pet treats as a surface (§8.2). */
    minWindowSize: { w: 160, h: 120 },
    /** Edge-coincidence tolerance in pt for occlusion tests (§8.3). */
    occlusionTolerance: 2,
    /** §8.2: a window needs alpha above this to be a surface (and to hide what is behind it). */
    minAlpha: 0.5,
    /**
     * The pet's size for the world, in body heights (tuning.render.bodyHeightPt for its size): half its width (how far
     * it stands from a wall it is about to climb, how much room it needs on a wall), the narrowest visible piece of a
     * window top it uses (§8.3 "shorter than the pet's width"), and how far its contact point stays inside a top's
     * visible ends (so it doesn't hang half off). Bigger = a more careful pet with fewer places to go.
     */
    pet: { halfWidthBodies: 0.6, minSegmentBodies: 1.2, edgeInsetBodies: 0.3 },
    /**
     * Route costs (§8.4 "walk < drop < climb < jump"): a route's cost is its travel time (walking, climbing, in the air)
     * plus these penalties per move, s. Higher = the pet avoids that kind of move.
     */
    navPenaltyS: { drop: 0.3, mount: 0.4, climb: 0.6, jump: 0.9 },
    /** While the pet rides a window, snapshots run fast (snapshotHz.attached) until the window has been still this long, s (decided adaptive polling). */
    attachedStillS: 1,
    /**
     * A hidden (auto-hide) Dock still keeps a thin strip of the display out of the work area. A work-area edge at most
     * this many pt inside the display edge counts as the display edge (§8.1: with an auto-hiding Dock the ground is
     * the display bottom). The menu bar side never does.
     */
    dockHiddenInsetPt: 5,
    /** Windows owned by these bundles are never surfaces (§8.2). */
    excludedBundleIds: [
      'com.apple.dock',
      'com.apple.controlcenter',
      'com.apple.notificationcenterui',
      'com.apple.Spotlight',
      'com.apple.screencaptureui',
      'com.apple.screenshot.launcher',
      'com.apple.systemuiserver',
      'com.apple.WindowManager',
      'com.apple.TextInputMenuAgent',
    ],
  },

  /** Character animation (§6.4). */
  anim: {
    /**
     * The default idle style (types.ts IdleMode; the dev panel switches it). SPEC-DEVIATION, decided by the user
     * 2026-10-08 ("calm"; docs/decisions/overlay.md "M2 measurements"): §6.4's idle bobs and sways all the time;
     * 'event' holds still between short events, about a third of the CPU. A user-facing "busy" option comes later.
     */
    idleMode: 'event' as IdleMode,
    /**
     * Eyes follow the cursor (§6.3: within ~300 pt, while idle). Main turns the cursor into a direction (look-left /
     * right / up) relative to the pet's eyes, eyeHeight of the pet box's height above its ground-contact point.
     * Beyond radiusPt: not looking. Up: the cursor more than upPt above the eyes and more above than beside them.
     * Left / right: more than sidePt beside them. Otherwise (on the face, or below it): straight ahead. A direction
     * holds until another one wins by hysteresisPt, so a cursor on a boundary doesn't make the eyes flicker.
     */
    look: { radiusPt: 300, eyeHeight: 0.55, upPt: 40, sidePt: 24, hysteresisPt: 8 },
    /** Seconds a change of state blends over (§6.4: 150–250 ms). Higher = softer, mushier transitions. */
    blendS: 0.2,
    /** Turning to face the walking direction (§6.1 "eased"): yaw approaches its target at this rate, 1/s. Higher = snappier turns. */
    yawEaseRate: 10,
    /** Blinks (§6.3: every 2–5 s, 120 ms). Sleepy: more often and longer (§6.4 "frequent long blinks"). */
    blink: { gapS: [2, 5], durationS: 0.12, sleepyGapS: [1, 2.5], sleepyDurationS: 0.3 },
    /**
     * Continuous idle (§6.4): body bob (rad/s, scene units), squash/stretch (±fraction), arm swing (rad, rad/s),
     * antenna sway (rad, rad/s) with a slower wobble. Higher = livelier, busier.
     */
    idle: { bobRate: 2.4, bobAmp: 0.045, squash: 0.012, armSwing: 0.12, armRate: 1.3, antennaSway: 0.12, antennaRate: 0.9 },
    /**
     * Event-driven idle (IdleMode 'event'): still between short events, one every gapS (random in the range): a glance
     * (eyes aside, glanceS), a breath (one bob cycle, breathS) or an antenna wiggle (wiggleS). Animated face overlays
     * (zzz asleep, the stuffed spinner) and the hungry light run in bursts of burstS every burstS + burstGapS; asleep,
     * only the zzz bursts run.
     * Shorter gaps = livelier, more renders.
     */
    event: { gapS: [3, 8], glanceS: [0.7, 1.3], breathS: 2.6, wiggleS: 1.2, burstS: 2, burstGapS: 6 },
    /** Walk (§6.4): steps per second per foot, bob (units), forward lean (rad), foot lift and stride (units), arm swing (rad), antenna lag (rad, negative = back). */
    walk: { stepHz: 2, bobAmp: 0.04, lean: 0.08, footLift: 0.08, stride: 0.1, armSwing: 0.35, antennaBack: -0.15 },
    /** Run (§6.4): as walk, faster and bigger, plus little hops (units). */
    run: { stepHz: 3.4, bobAmp: 0.06, lean: 0.18, footLift: 0.12, stride: 0.16, armSwing: 0.8, antennaBack: -0.5, hop: 0.04 },
    /**
     * Climb (§6.4): alternating reaches per second, arm reach (rad), foot step (units), bob along the wall (units). On a
     * wall the antenna hangs with gravity: it turns by wallAntenna (rad, + = toward the pet's back, as antZ) on a wall to
     * its right / left (the antenna leans to the pet's left, so the two sides differ). Bigger = a floppier antenna.
     */
    climb: { reachHz: 1.6, armReach: 0.9, footStep: 0.06, bob: 0.03, wallAntenna: { wallRight: 1.2, wallLeft: -0.6 } },
    /** Sit (§6.4): body lowered (units), feet forward (units), dangling feet swing (units, Hz), arms resting in (rad), antenna relaxed (rad). */
    sit: { lower: 0.12, feetForward: 0.22, feetSwing: 0.05, feetSwingHz: 1.1, armsIn: -0.15, antenna: -0.1 },
    /** Sleep (§6.4: slow bob 0.9 rad/s, amp 0.02; slumped; antenna droops −0.5; power light dims). */
    sleep: { bobRate: 0.9, bobAmp: 0.02, slump: 0.12, lower: 0.05, armsLimp: 0.12, antennaDroop: -0.5, powerGlow: 0.25 },
    /** Eat (§6.4): rapid bounces (Hz, units), arms pumping in (Hz, rad), antenna perks up (rad), chewing (Hz, §6.3 ~12), antenna tip flashes (Hz, × rest glow). */
    eat: { bounceHz: 3.5, bounceAmp: 0.03, pumpHz: 3, pump: 0.3, antennaPerk: 0.25, chewHz: 12, tipFlashHz: 3, tipFlash: 2.2 },
    /** Fall (§6.4): tumble (rad/s), arm flail (Hz, rad), antenna whip (Hz, rad). */
    fall: { tumbleRate: 7, flailHz: 8, flail: 0.8, whipHz: 10, whip: 0.6 },
    /**
     * Land (§6.4, for tuning.move.landS): squash to `squash` of the height, overshoot to `stretch`, settle; arms out
     * (rad), antenna boing (rad); wide eyes for the first wideFraction of it. It blends in over blendS only (an impact
     * is sudden: the usual blendS would swallow the squash).
     */
    land: { squash: 0.75, stretch: 1.08, armsOut: 0.6, boing: 0.5, wideFraction: 0.4, blendS: 0.04 },
    /**
     * Held (§6.4): the pet swings about the grab point like a pendulum of lengthPt under gravityPt (pt/s²), damped
     * (1/s), at most maxAngle (rad); idleSway (rad) without a drag to follow. Shaking it (summed speed changes over
     * ~shakeWindowS above dizzyShakePt pt/s) makes it dizzy for dizzyS. Longer = lazier swings.
     */
    held: {
      lengthPt: 80,
      gravityPt: 2600,
      damping: 3.5,
      maxAngle: 0.9,
      idleSway: 0.05,
      shakeWindowS: 0.5,
      dizzyShakePt: 9000,
      dizzyS: 1.5,
      armsOut: 0.25,
      feetDrop: 0.05,
    },
    /** Celebrate (§6.4): one jump with a full spin per periodS, height (units), arms up (rad), fast antenna wiggle (Hz, rad). */
    celebrate: { periodS: 1.2, jump: 0.25, armsUp: 2.4, antennaWiggleHz: 8, antennaWiggle: 0.35 },
    /** Peek (§6.4): leans out (rad), one arm up on the edge (rad). */
    peek: { lean: 0.35, armUp: 2.2 },
    /** Greet (§10.1; not in the §6.4 table): one arm waves (rad up, Hz, ± rad), a small bounce (units). */
    greet: { armUp: 2.3, waveHz: 3, wave: 0.45, bounceAmp: 0.02 },
    /**
     * Jump (§10.1; not in the §6.4 table): the simulation moves the pet along the arc (tuning.move.jumpApexPt), so the
     * pose adds no lift of its own: it stretches to `stretch` of its height and raises its arms (rad) over riseS, then
     * holds. Shorter riseS = a snappier take-off.
     */
    jump: { riseS: 0.15, stretch: 1.1, armsUp: 1.4 },
    /**
     * Mood cues (§6.4), layered on any state: hungry antenna droop (rad) and amber light blink (Hz); sleepy idle runs
     * at sleepyRate of its speed and yawns (gap, duration s); stuffed burps (gap, duration s); happy hops (units) or
     * wiggles (rad) now and then (gap, duration s); bored glances around more often (gap s).
     */
    mood: {
      hungryAntenna: -0.9,
      amberBlinkHz: 3,
      sleepyRate: 0.6,
      yawnGapS: [10, 20],
      yawnS: 1.2,
      burpGapS: [8, 15],
      burpS: 0.5,
      happyGapS: [6, 12],
      happyS: 0.4,
      hop: 0.06,
      wiggle: 0.12,
      boredGlanceGapS: [2, 4],
    },
    /** Animated face overlays (zzz, loading, static, heart-pop) step this many frames per second (§6.3). */
    face: { frameHz: 8 },
    /**
     * Dust (§6.4 "dusty"): grey specks on the body, as many as level × maxSpecks, shown from visibleFrom (§9.1: dust
     * ≥ 30 → visible). radius in scene units. More specks = reads dustier.
     */
    dust: { visibleFrom: 0.3, maxSpecks: 36, radius: 0.04, color: '#6F6D63', seed: 7 },
    /**
     * Rest emissive intensities of the glowing bits (§6.1). M2 animates them: the antenna tip
     * flashes while eating, the power light dims asleep, the amber light blinks when hungry.
     * 1 − render.glowAlbedo (0.75) = the part's exact hex on the lit front; above that it washes
     * out toward white (a flash); 0 = unlit plastic (off).
     */
    glow: { antennaTip: 0.75, powerLight: 0.75, amberLight: 0.75 },
  },

  /** Behavior (§10.2). M3 has only `wander`; the utility AI (M6) replaces it. */
  brain: {
    /**
     * M3's stand-in for Roam: after arriving it pauses pauseS (random in the range), then goes somewhere reachable:
     * a window top with probability windowBias (else anywhere), up a wall or window side for fun with climbChance.
     */
    wander: { pauseS: [2, 6] as readonly [number, number], windowBias: 0.6, climbChance: 0.15 },
  },

  /** bitbot-helper process management (§5.3). */
  helper: {
    /** Wait for a reply before a request rejects. Lower = faster failure detection, more spurious timeouts on a busy Mac. */
    requestTimeoutMs: 2000,
    /** requestInputAccess may sit behind the system permission prompt, so it gets much longer. */
    interactiveRequestTimeoutMs: 120_000,
    /** Restart delay after an unexpected exit: initialMs × factor^n, capped at maxMs. Lower = faster recovery, more churn if it keeps crashing. */
    restartBackoff: { initialMs: 250, factor: 2, maxMs: 30_000 },
    /** A run lasting this long counts as healthy and resets the backoff to initialMs. */
    stableUptimeMs: 30_000,
    /** stop(): wait this long after "quit" before SIGTERM, then again before SIGKILL. */
    stopGraceMs: 1000,
    /** Longest helper stdout line accepted (chars; a snapshot is ~13 kB per 100 windows). Longer lines are dropped as corrupt. */
    maxLineChars: 4_000_000,
    /** Longest helper stderr line kept (chars; its diagnostics are one short line each). Longer lines are dropped. */
    maxStderrLineChars: 16_384,
    /** setPollRate is clamped to this (Hz). Higher = tighter window riding, more CPU. */
    maxPollHz: 30,
    /** Fullscreen re-check rate (Hz) inside the helper while snapshot polling is off or slower. Lower = cheaper, slower to hide. */
    fullscreenIdleHz: 1,
    /** §5.3 fullscreen test: a window covers a display when its bounds match within this many pt. Higher = also hides for nearly-fullscreen windows. */
    fullscreenTolerancePt: 1,
    /** Fullscreen is re-checked this long after an app activation or Space change, once the ~0.7 s native transition has settled. 0 = no follow-up. */
    fullscreenFollowUpMs: 600,
    /** The helper re-reads state it keeps current from notifications (frontmost app, display bounds) at least this often. Lower = faster recovery from a missed notification, more CPU. */
    resyncMs: 5000,
    /**
     * Liveness watchdog: ping the helper every heartbeatMs; maxMissedHeartbeats consecutive pings
     * unanswered within requestTimeoutMs mean it is wedged (e.g. stuck in a window-server call), so it
     * is killed and restarted. Lower = faster recovery, more risk of killing a briefly busy helper.
     */
    watchdog: { heartbeatMs: 5000, maxMissedHeartbeats: 2 },
  },

  /** Dev tools (not shipped behaviour). */
  dev: {
    /** The developer panel window (§14.1, dev builds): its size, pt, and how often its status refreshes, ms. */
    panel: { width: 380, height: 720, statusIntervalMs: 1000 },
    /**
     * The overlay's debug view of the world (§14.1, the dev panel's "Show world"): line colours and widths, CSS px.
     * Eligible windows thin, walkable segments and climbable walls thick, moves between surfaces thin and dashed
     * (coloured by kind), the route as a polyline, the pet's box (boxFor its attach) thin. Wider = easier to see, hides
     * more of what is underneath.
     */
    worldView: {
      window: { color: 'rgba(120, 160, 255, 0.7)', width: 1 },
      segment: { color: 'rgba(40, 210, 120, 0.9)', width: 4 },
      wall: { color: 'rgba(230, 70, 200, 0.9)', width: 4 },
      link: {
        colors: { walk: '#9be38c', drop: '#5ac8fa', jump: '#ffd60a', climb: '#ff6ad5', mount: '#bf9bff' },
        width: 1,
        dash: [5, 4] as readonly number[],
      },
      path: { color: '#ff9500', width: 3 },
      petBox: { color: 'rgba(255, 59, 48, 0.9)', width: 1 },
    },
    /** PNG snapshot tool: give up if the hidden renderer hasn't drawn within this many ms. */
    snapshotReadyTimeoutMs: 15_000,
    /** PNG snapshot tool: wait after drawing so the compositor presents the frame before capture. */
    snapshotPresentDelayMs: 100,
    /**
     * The M1 dev check (`electron . --check=overlay`, src/main/dev/overlayCheck.ts): functional checks of the overlay
     * and its grab area in the real app, and the measurements that decide approach B (hardened) vs the A2 fallback
     * (docs/decisions/overlay.md). Only the check reads these.
     */
    overlayCheck: {
      /** Longest wait for bitbot-helper's hello after Bitbot started, ms. */
      helperHelloTimeoutMs: 5000,
      /** Longest wait for the overlay's pet:ready (first load and after the reload), ms. */
      readyTimeoutMs: 20_000,
      /** Default deadline for a state the check waits for (grab area shown, pet held, released…), ms. Generous: a miss is a FAIL. */
      deadlineMs: 3000,
      /** How often a wait re-reads the state, ms. Lower = finer timings in the log, more main-process wake-ups. */
      pollMs: 5,
      /** How long a state must hold to count (the grab area stays hidden while the cursor is far, the mouse stays off), ms. */
      holdMs: 300,
      /** Longest wait for the overlay's renderer counters (debug:overlay-stats), ms. */
      statsTimeoutMs: 3000,
      /** Longest run of /usr/bin/footprint, ps and pmset, ms. */
      toolTimeoutMs: 10_000,
      /** The whole check gives up (FAIL, clean quit) after this long, s. Above the phases' total. */
      hardTimeoutS: 600,
      /** Spot for "the cursor is far": this far inside the work area from its top-left corner, pt. */
      farInsetPt: 24,
      /**
       * "Near the pet but off its silhouette" for the event-path check: this far inside the pet's box from its top-left
       * corner, pt (the empty corner beside the antenna; inside the box, so the click-through safety net stays quiet).
       */
      boxCornerInsetPt: 6,
      /** Presses land at this point of the pet's box, as fractions from its top-left (0.5, 0.6: the middle of the body). */
      pressAt: { x: 0.5, y: 0.6 },
      /**
       * The functional drag: this many moves of stepPt each, intervalMs apart (up and left: the drop is in the air, and
       * far enough from the start that the two captures don't overlap).
       */
      drag: { moves: 16, stepPt: { x: -25, y: -18 }, intervalMs: 16 },
      /** A press that becomes a drag (lost mouseup, cancel by hiding): moves of stepPt, well past hitArea.clickMaxMovePt. */
      shortDrag: { moves: 4, stepPt: { x: 6, y: -12 }, intervalMs: 16 },
      /** The held pet must sit within this many pt of the cursor minus the grab offset. */
      followTolerancePt: 1,
      /** A drop must land within its fall time (tuning.move physics at the simulation's step) plus this, ms. */
      landMarginMs: 300,
      /** Captures: a pixel whose alpha is above this counts as drawn (0–255). */
      drawnAlpha: 8,
      /** The capture at the pet's new spot needs at least this many drawn device pixels (the M pet covers ~40k at 2×). */
      minPetPixels: 5000,
      /** While hidden, the simulation must not step for this long, ms. */
      hiddenHoldMs: 500,
      /** Wait before the last checks so the activation monitor's verdicts are in (after tuning.app.activationVerdictDelayMs), ms. */
      verdictWaitMs: 600,
      /** app.getAppMetrics() sampling period during a phase, ms (Spike A sampled every 1000 ms too). */
      metricsIntervalMs: 1000,
      /** Before each measured phase the new motion runs this long unmeasured, ms. */
      phaseSettleMs: 1500,
      /** Measured length of each phase, s. Longer = steadier CPU means and more latency samples, a longer check. */
      phaseS: {
        idle: 20,
        idleContinuous: 10,
        sleepEvent: 24,
        sleepContinuous: 10,
        hidden: 10,
        nearStill: 10,
        walkParked: 24,
        walkCursor: 15,
        chase: 15,
        drag120: 12,
        drag600: 12,
      },
      /**
       * Walk under a parked cursor: the pet walks ±this many pt around its home at tuning.move.walkSpeed, the cursor parked
       * at its home x. More than the silhouette's half-width (so the cursor is clear of it at the turns) and less than
       * that plus hitArea.nearMarginPt (so the grab area stays shown): every pass is one enter and one leave. A round trip
       * (4 × span ÷ walkSpeed) is not a whole number of simulation steps, so successive crossings fall at different phases
       * of the 30 Hz wake instead of all at the same one.
       */
      walkParkedSpanPt: 100.4,
      /** …the parked cursor's height in the pet's box, as a fraction from its top (0.58: the middle of the body). */
      parkedCursorAt: 0.58,
      /** Walk with the cursor near: the pet walks ±this many pt around its home. */
      walkCursorSpanPt: 400,
      /**
       * The cursor near a moving pet: gapPt right of its box at `at` of its height from the top, circling with radius
       * wobblePt at wobbleHz (a hand that moves). Gap ± wobble stays inside hitArea.nearMarginPt and off the pet.
       */
      nearCursor: { gapPt: 16, at: 0.5, wobblePt: 8, wobbleHz: 1 },
      /**
       * The hit test's span at the parked cursor's height, measured with the pet still before the latency phase:
       * binary-search steps per edge (each halves the uncertainty; keep the last step above hitArea.cursorStreamMinMovePt)
       * and the wait for each probe's hover verdict, ms (above one simulation step plus the IPC round trip).
       */
      calibration: { steps: 7, probeMs: 100 },
      /** Latency pairing: a mouse toggle later than this after its silhouette crossing counts as missing, ms. */
      latencyWindowMs: 500,
      /** …and a toggle up to this long before its crossing still pairs (a negative latency: the hit test's halo), ms. */
      latencyEarlyMs: 50,
      /**
       * The chase: the pet chases a Lissajous target at up to `speed` pt/s, the target's peak speed `peakSpeed` (above
       * `speed`, so the chase saturates). The same path as Spike A's synthetic mode, so the numbers compare.
       */
      chase: { speed: 600, peakSpeed: 750, freqX: 3, freqY: 2, phaseX: Math.PI / 2, fill: 0.92 },
      /**
       * The drag patrol: pressed at home, lifted liftPt at the patrol's speed, then back and forth ±spanPt around home;
       * synthetic moves every eventIntervalMs (≈67 Hz, like a trackpad, and not a divisor of the 60 Hz frame period,
       * so events land at every phase of a frame). One phase per speed, pt/s.
       */
      dragPatrol: { liftPt: 220, spanPt: 300, eventIntervalMs: 15, speeds: { slow: 120, fast: 600 } },
      /** A2 spike results count as the same session's when they started at most this long before the check, min. */
      a2MaxAgeMin: 30,
      /** The verdict's thresholds. CPU vs A2 is report-only (it depends on the machine); the others gate the exit code. */
      thresholds: {
        /** Renderer frames while hidden. (Idle and asleep animate: their renders are reported, not judged.) */
        hiddenFrames: 0,
        /** Drag input→frame p95 may exceed one display frame by this much, ms. */
        dragFrameSlackMs: 2,
        /** Share of wakes with the pet's box outside the grab area while it is shown, %. */
        boxOutsidePct: 1,
        /** The silhouette reached the still cursor → the grab area takes the mouse: p95, ms. */
        enterP95Ms: 150,
        /** The silhouette left the still cursor → click-through again: p95, ms. */
        leaveP95Ms: 100,
        /** phys_footprint summed over the Electron processes (not the helper), MB. */
        footprintMB: 210,
      },
    },
  },

  /** Throwaway values for the §12 Spike A harness. Removed with the harness. */
  spikeOverlay: {
    /** Cursor-follow max speed, pt/s (§12). */
    followSpeed: 600,
    /** Fixed simulation step for the harness, Hz (matches the real sim, §5.1). */
    simHz: 30,
    /** Main-process presentation timer for variant A1, Hz. */
    a1TimerHz: 60,
    /** Run length when --duration is not given, s. */
    defaultDurationS: 15,
    /** Start-of-run period excluded from every statistic, s. */
    warmupS: 2,
    /** Scheduler wakes that owe more steps than this drop the excess time instead of bursting. */
    maxStepsPerWake: 5,
    /**
     * Sim steps are computed up to this many ms before their nominal time. Presentation renders one
     * step behind real time, so main-process timer lateness below this never starves it (no stall/jump).
     * SPEC-DEVIATION (§5.1 computes a step once its time has passed): see scheduleSim in the harness.
     */
    simLeadMs: 8,
    /** Synthetic mode target: Lissajous path scaled so its peak speed is `peakSpeed` pt/s (≥ followSpeed so the chase saturates). */
    synthetic: { peakSpeed: 750, freqX: 3, freqY: 2, phaseX: Math.PI / 2, fill: 0.92 },
    /** Follow mode: the pet's top stops this many pt below the cursor so the cursor stays off the pet. */
    followGapPt: 24,
    /** Yaw easing toward the walking direction, 1/s. Higher = snappier turns. */
    facingEaseRate: 10,
    /** Horizontal speed (pt/s) below which facing never flips (no flicker while nearly still). */
    facingDeadband: 20,
    /** Click-through safety net: margin (pt) around the pet's projected box before forcing click-through back on. */
    safetyMarginPt: 8,
    /** A press that moves less than this (pt) is a 'pet' click, not a drag (§10.4). */
    petClickMaxMovePt: 4,
    /** Toss velocity = cursor velocity over this trailing window, ms. */
    releaseWindowMs: 80,
    /** Toss physics on top of tuning.move gravity/terminalVelocity. Higher restitution = bouncier landings. */
    toss: { restitution: 0.35, minBounceSpeed: 400, groundFriction: 0.6, wallRestitution: 0.5, landPauseS: 0.25 },
    /** app.getAppMetrics() sampling period, ms. */
    metricsIntervalMs: 1000,
    /** Renderer frame intervals above this (ms) count as long/dropped frames. */
    longFrameMs: 20,
    /** Max raw samples kept per series (results JSON size guard). */
    rawSampleCap: 20000,
    /** Interactive focus verdict waits this long (ms) after an interaction for activation events. */
    focusVerdictDelayMs: 400,
    /** Safety net: a renderer leave arriving this soon (ms) after a firing means forwarding worked, just late ("raced"). */
    safetyNetRaceMs: 150,
    /** Safety net: the cursor "moved" if it was over cursorMovedMinPt from its current spot during the last cursorMovedWindowMs. */
    cursorMovedWindowMs: 100,
    cursorMovedMinPt: 2,
    /** Right-click menu > Hide: hidden for this long, ms. */
    hideMs: 2000,
    /** Renderer (B/Bfull): newest sim states kept for interpolation. */
    stateBufferSize: 8,
    /** Renderer (B/Bfull): after a drop, draw the pet at the drop point until main's snap state arrives, at most this long (ms). */
    dropHoldMs: 250,
    /** Renderer: most time (s) the yaw easing integrates in one frame, so a stalled tab does not snap the turn. */
    maxEaseDtS: 0.1,
    /** A1/A2: how often (ms) main compares getPosition() with the last setPosition(). */
    positionCheckIntervalMs: 1000,
    /**
     * A terminal Ctrl+C reaches Electron twice (the whole process group gets SIGINT and electron's cli.js
     * forwards it again). Repeats within this many ms of the first signal are ignored; a later one
     * force-quits without writing results.
     */
    signalRepeatGraceMs: 1000,
    /** Harness plumbing timeouts, ms: renderer ready, renderer stats at exit, `footprint` memory read at exit, app.quit() before app.exit(). */
    timeouts: { rendererReadyMs: 20_000, rendererStatsMs: 3000, footprintMs: 10_000, quitFallbackMs: 3000 },
  },

  /** Throwaway values for the §12 Spike B windows harness. Removed with the harness. */
  spikeWindows: {
    /** Run length when --duration is not given, s (0 = until Ctrl+C). */
    defaultDurationS: 30,
    /** Wait this long for the helper's hello after spawning it, ms. */
    helloTimeoutMs: 5000,
    /** Wait this long for a debug page (overlay or probe) to report it has drawn, ms. */
    rendererReadyMs: 15_000,
    /** Cursor crosshair refresh, Hz (the production cursor poll is 20 Hz, §7.1). */
    cursorHz: 20,
    /** HUD text refresh, ms. */
    statusIntervalMs: 1000,
    /** Coordinate probe: a small frameless window moved around the display and compared with the helper. */
    probe: {
      width: 200,
      height: 120,
      /** Wait after each move before the first snapshot request, ms. */
      settleMs: 150,
      /** Snapshot attempts per position before it counts as a mismatch (absorbs window-server lag). */
      attempts: 4,
      /** Pause between attempts, ms. */
      retryMs: 100,
      /** Share of the probe pushed past the right / bottom display edge in the off-screen positions. */
      offscreenFraction: 0.5,
    },
    /** Helper and Electron bounds must agree within this many pt (both report integral points here). */
    boundsTolerancePt: 0.5,
    /**
     * §8.2 eligibility: a window needs alpha above this. Belongs in tuning.world once the world model
     * exists (that section is not this harness's to edit); the rest of the rule reuses tuning.world.
     */
    eligibleMinAlpha: 0.5,
    /**
     * Round-trip latency is measured in bursts (after the checks, then at the end of each CPU phase):
     * each burst times this many sequential snapshot and ping requests after `warmup` untimed ones.
     */
    latencyBurst: { samples: 40, warmup: 3 },
    /**
     * Helper CPU: `ps -o time=` (cumulative, rounded to 10 ms) every sampleMs, starting settleMs after
     * the poll-rate change. After the checks the remaining run time is split into a 4 Hz and a 15 Hz
     * phase (at least minPhaseS each); defaultPhaseS is used with --duration=0, --cpu-phase-s overrides.
     * A phase whose bounds are wider than ±maxHalfWidthPct points prints n/a (below resolution).
     * Shorter sampleMs = tighter bounds (each ±one interval at both ends), more `ps` spawns.
     * helperBudgetPct is §11's "helper < 0.5% CPU".
     */
    cpu: { sampleMs: 200, settleMs: 500, minPhaseS: 5, defaultPhaseS: 30, maxHalfWidthPct: 0.05, helperBudgetPct: 0.5 },
    /** --auto-app-test: launched with `open -g` (never activated), then terminated. */
    appTest: { appName: 'Calculator', bundleId: 'com.apple.calculator', eventTimeoutMs: 10_000, killGraceMs: 3000 },
    /** After a fullscreen change, wait this long (Space-switch animation) before checking whether the overlay is on screen, ms. */
    fullscreenCheckDelayMs: 700,
    /** Snapshot entries printed by the z-order dump. */
    zOrderDumpCount: 12,
    /** A run that has not finished this long after --duration (a hung check) is forced to finish, s. */
    hardStopGraceS: 45,
    /** --capture: wait this long for the overlay to draw the newest scene before capturePage(), ms. */
    captureTimeoutMs: 3000,
    /** helper.stop() is abandoned after this long (then the process is killed), ms. */
    helperStopTimeoutMs: 5000,
    /** app.quit() falls back to app.exit() after this long, ms. */
    quitFallbackMs: 3000,
    /** A repeat of the first SIGINT/SIGTERM within this many ms is the same Ctrl+C echoed by electron's cli.js. */
    signalRepeatGraceMs: 1000,
    /** Debug overlay drawing, CSS px. Bigger labels are easier to read but hide more of the windows. */
    overlay: {
      labelFontPx: 11,
      labelPadPx: 3,
      eligibleLineWidth: 2,
      ineligibleLineWidth: 1,
      dash: [6, 4],
      /** A label that collides is moved down by one label height at most this many times. */
      maxLabelShifts: 6,
      crosshairGapPx: 6,
    },
  },

  /** Throwaway values for the §12 Spike B input harness. Removed with the harness. */
  spikeInput: {
    /** Run length when --duration is not given, s (0 = until Ctrl+C). */
    defaultDurationS: 60,
    /** Print and log the per-interval counts this often, s. */
    reportIntervalS: 5,
    /** Wait this long for the helper's hello after spawning it, ms. */
    helloTimeoutMs: 5000,
    /** While the helper tap is not running: re-check Input Monitoring (preflight, never prompts) this often, ms. */
    grantPollMs: 1000,
    /**
     * When the same-process retry after a grant fails with tapCreateFailed, the harness restarts the helper
     * (SIGTERM; the client respawns it and re-applies the tap) and waits this long for the re-applied
     * result before recording a FAIL, ms. Covers the client's restart backoff plus spawn and hello.
     */
    restartAfterGrantTimeoutMs: 10_000,
    /** Event ages (receipt time − event timestamp) outside 0..this many s count as implausible (wrong timestamp unit). */
    maxPlausibleAgeS: 10,
    /** At most this many event ages are kept for the latency percentiles. */
    ageSampleCap: 20_000,
    /** helper.stop() is abandoned after this long, ms. */
    helperStopTimeoutMs: 5000,
    /** app.quit() falls back to app.exit() after this long, ms. */
    quitFallbackMs: 3000,
    /** A repeat of the first SIGINT/SIGTERM within this many ms is the same Ctrl+C echoed by electron's cli.js. */
    signalRepeatGraceMs: 1000,
  },
} as const

export type Tuning = typeof tuning

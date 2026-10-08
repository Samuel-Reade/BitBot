// ALL balance and behavior constants live here (BITBOT_SPEC.md §0.4, §17).
// Never hard-code a tunable number elsewhere — import it from this file.
// Sections are filled in milestone by milestone; comments say what raising/lowering feels like.

import type { PetSize } from './types'

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
    /** Display changes arrive in bursts; the overlay is re-laid out this long after the last one, ms. */
    displayChangeDebounceMs: 100,
    /** A crashed overlay renderer is recreated after this long, ms. */
    recreateDelayMs: 1000,
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
    /** It moves once the pet's box comes within this many pt of its edge. */
    innerMarginPt: 4,
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
  },

  world: {
    /** Helper snapshot rates in Hz (§5.3, §11). Higher = tighter window riding, more CPU. */
    snapshotHz: { normal: 4, attached: 15, asleep: 1 },
    /** Smallest window (pt) the pet treats as a surface (§8.2). */
    minWindowSize: { w: 160, h: 120 },
    /** Edge-coincidence tolerance in pt for occlusion tests (§8.3). */
    occlusionTolerance: 2,
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

  /** Character animation (§6.4). Filled in by the character work; M2 adds the full state set. */
  anim: {
    /**
     * Rest emissive intensities of the glowing bits (§6.1). M2 animates them: the antenna tip
     * flashes while eating, the power light dims asleep, the amber light blinks when hungry.
     * 1 − render.glowAlbedo (0.75) = the part's exact hex on the lit front; above that it washes
     * out toward white (a flash); 0 = unlit plastic (off).
     */
    glow: { antennaTip: 0.75, powerLight: 0.75, amberLight: 0.75 },
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
    /** PNG snapshot tool: give up if the hidden renderer hasn't drawn within this many ms. */
    snapshotReadyTimeoutMs: 15_000,
    /** PNG snapshot tool: wait after drawing so the compositor presents the frame before capture. */
    snapshotPresentDelayMs: 100,
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

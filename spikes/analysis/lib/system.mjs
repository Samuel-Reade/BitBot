// Parsers for the system samplers used by bench-run.mjs (no permissions needed, nothing prompts).

/** "Device/Renderer/Tiler Utilization %" from `ioreg -r -d 1 -w 0 -c IOAccelerator` (first GPU). */
export function parseIoregUtilization(text) {
  const grab = (key) => {
    const m = new RegExp(`"${key}"=(\\d+(?:\\.\\d+)?)`).exec(text)
    return m ? Number(m[1]) : null
  }
  return {
    device: grab('Device Utilization %'),
    renderer: grab('Renderer Utilization %'),
    tiler: grab('Tiler Utilization %'),
  }
}

/**
 * Cumulative CPU time from `ps -o time= -p PID`, in seconds. macOS prints "MMM:SS.cc" (minutes
 * unbounded); also accepts "[[DD-]HH:]MM:SS[.cc]".
 */
export function parsePsCpuTime(text) {
  const s = String(text).trim()
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3])
  const seconds = Number(m[4])
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds
}

/** `ps -o pid=,time= -p A,B` output → Map(pid → cumulative CPU seconds). Missing pids are simply absent. */
export function parsePsPidTimes(text) {
  const out = new Map()
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    const seconds = parsePsCpuTime(m[2])
    if (seconds !== null) out.set(Number(m[1]), seconds)
  }
  return out
}

/**
 * What the bench runs for a bench variant. 'A1i' is an alias for the A1 harness with the naive
 * setInterval timer; its results get the label `<label>-a1i` so they do not overwrite A1's.
 */
export function benchTarget(variant, label) {
  if (variant === 'A1i') return { variant: 'A1', label: `${label}-a1i`, extraArgs: ['--a1-timer=interval'] }
  return { variant, label, extraArgs: [] }
}

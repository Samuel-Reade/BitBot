// Types for system.mjs (lets the TypeScript tests import the analysis code).
export function parseIoregUtilization(text: string): { device: number | null; renderer: number | null; tiler: number | null }
export function parsePsCpuTime(text: string): number | null
export function parsePsPidTimes(text: string): Map<number, number>
export function benchTarget(variant: string, label: string): { variant: string; label: string; extraArgs: string[] }

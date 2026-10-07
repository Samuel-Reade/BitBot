import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { RoundedBoxDims, Vec3 } from './construction'

// Procedural geometry helpers for the rig (§6.1). Pure three.js: runs in Node for tests.

export interface RoundedBoxQuality {
  readonly curveSegments: number
  readonly bevelSegments: number
}

/** §6.1 quality for visible meshes. */
export const ROUNDED_BOX_QUALITY: RoundedBoxQuality = { curveSegments: 16, bevelSegments: 8 }

/** Rounded rectangle centered on the origin, with true circular corners. */
export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const x = -w / 2
  const y = -h / 2
  const rr = Math.min(r, w / 2, h / 2)
  const s = new THREE.Shape()
  s.moveTo(x + rr, y)
  s.lineTo(x + w - rr, y)
  s.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - rr)
  s.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false)
  s.lineTo(x + rr, y + h)
  s.absarc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + rr)
  s.absarc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false)
  return s
}

/**
 * §6.1 rounded box: rounded-rect Shape → ExtrudeGeometry (bevel on, bevelThickness = bevelSize =
 * bevel) → center(). The bevel adds to the outer size: outer = (w, h, depth) + 2·bevel.
 *
 * ExtrudeGeometry is non-indexed with one flat normal per triangle, which shows the 8 bevel
 * segments as bands under the key light. The surface is smooth (G1) everywhere, so we weld the
 * vertices and recompute area-weighted normals: same shape, smooth shading, flat faces stay flat.
 */
export function roundedBoxGeometry(d: RoundedBoxDims, quality: RoundedBoxQuality = ROUNDED_BOX_QUALITY): THREE.BufferGeometry {
  const extruded = new THREE.ExtrudeGeometry(roundedRectShape(d.w, d.h, d.r), {
    depth: d.depth,
    bevelEnabled: true,
    bevelThickness: d.bevel,
    bevelSize: d.bevel,
    bevelSegments: quality.bevelSegments,
    curveSegments: quality.curveSegments,
  })
  extruded.center()
  return smoothShaded(extruded)
}

/** Welds coincident vertices (dropping uv/normal, which differ across seams) and recomputes smooth normals. */
export function smoothShaded(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.deleteAttribute('normal')
  geometry.deleteAttribute('uv')
  const welded = mergeVertices(geometry)
  geometry.dispose()
  welded.computeVertexNormals()
  welded.computeBoundingBox()
  welded.computeBoundingSphere()
  return welded
}

/** §6.1 screen: a w × h plane with segments², each vertex pushed to z = base − (x² + y²) · k. */
export function bulgedScreenGeometry(w: number, h: number, segments: number, base: number, k: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(w, h, segments, segments)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const y = position.getY(i)
    position.setZ(i, base - (x * x + y * y) * k)
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** Copies of `geometry` translated to each position, merged into one geometry (one draw call). */
export function instancedMerge(geometry: THREE.BufferGeometry, positions: readonly Vec3[]): THREE.BufferGeometry {
  return mergeAll(positions.map(([x, y, z]) => geometry.clone().translate(x, y, z)))
}

/** Merges geometries that share a material into one (one draw call) and disposes the inputs. */
export function mergeAll(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries([...geometries], false)
  for (const geometry of geometries) geometry.dispose()
  if (!merged) throw new Error('mergeAll: incompatible geometries')
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

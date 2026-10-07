import * as THREE from 'three'
import type { BitbotRig } from './buildBitbot'
import { HIT_LAYER } from './hitProxies'

// Pointer hit-testing (§5.2): raycasts the rig's invisible collision proxies, and only them
// (HIT_LAYER). Shared by scene.ts and the tests, so the tested code is the shipped code.

/** Returns hitTest(x, y): true if viewport point (CSS px from the top-left) is over the pet. */
export function createHitTester(
  rig: Pick<BitbotRig, 'root' | 'hitTargets'>,
  camera: THREE.Camera,
  width: number,
  height: number,
): (x: number, y: number) => boolean {
  const raycaster = new THREE.Raycaster()
  raycaster.layers.set(HIT_LAYER)
  const ndc = new THREE.Vector2()
  const hits: THREE.Intersection[] = []
  return (x, y) => {
    ndc.set((x / width) * 2 - 1, 1 - (y / height) * 2)
    raycaster.setFromCamera(ndc, camera)
    // The pose may have changed since the last render (render-on-demand loop).
    rig.root.updateMatrixWorld()
    hits.length = 0
    raycaster.intersectObjects(rig.hitTargets, false, hits)
    return hits.length > 0
  }
}

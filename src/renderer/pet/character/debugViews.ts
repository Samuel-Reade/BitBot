import * as THREE from 'three'
import type { BitbotRig } from './buildBitbot'
import { HIT_LAYER } from './hitProxies'

// Dev-only visualizations of the rig (snapshot tool now, dev panel's "pet hitbox" later, §14.1).

/** Draws the hit proxies (wireframe, magenta) through `camera` by enabling HIT_LAYER on it. */
export function showHitProxies(camera: THREE.Camera, on: boolean): void {
  if (on) camera.layers.enable(HIT_LAYER)
  else camera.layers.disable(HIT_LAYER)
}

/** Adds a small always-on-top marker at every attach point; returns a function that removes them. */
export function addAttachMarkers(rig: BitbotRig, radius = 0.04): () => void {
  const geometry = new THREE.SphereGeometry(radius, 12, 8)
  const material = new THREE.MeshBasicMaterial({ color: 0xff2a6d, depthTest: false })
  const markers = Object.values(rig.attachPoints).map((anchor) => {
    const marker = new THREE.Mesh(geometry, material)
    marker.name = `debug:${anchor.name}`
    marker.renderOrder = 999
    anchor.add(marker)
    return marker
  })
  return () => {
    for (const marker of markers) marker.removeFromParent()
    geometry.dispose()
    material.dispose()
  }
}

// Third-person chase camera. Free-look follows the mouse; with a lock-on it swings to keep the
// target framed. It pulls back and widens its field of view when the mech boosts, backs away from
// buildings, and shakes with a trauma model (shake strength = trauma squared).

import * as THREE from 'three';
import { clamp, damp, dampAngle } from './util.js';

const BASE_FOV = 66;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = -0.05;
    this.sensitivity = 0.0022;
    this.forward = new THREE.Vector3(0, 0, -1);
    this.trauma = 0;
    this.dist = 46;
    this.fov = BASE_FOV;
    this.orbit = 0;

    this._focus = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this.initialised = false;
  }

  reset(yaw = 0) {
    this.yaw = yaw;
    this.pitch = -0.05;
    this.trauma = 0;
    this.orbit = 0;
    this.initialised = false;
  }

  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch = clamp(this.pitch - dy * this.sensitivity, -0.8, 1.0);
  }

  addTrauma(a) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  update(dt, player, world) {
    const mech = player.mech;
    const s = mech.spec.scale;
    const focus = this._focus.set(mech.pos.x, mech.pos.y + 12 * s, mech.pos.z);

    if (mech.dead) {
      // slow orbit around the wreck
      this.orbit += dt * 0.35;
      this.yaw += dt * 0.35;
      this.pitch = damp(this.pitch, 0.25, 2, dt);
    } else if (player.lock) {
      // Aim from where the camera actually sits (it is offset to the shoulder), so the target
      // lands on the crosshair and the mech stays to the side instead of blocking the view.
      const c = player.lock.center(this._t);
      const cam = this.camera.position;
      const dx = c.x - cam.x, dz = c.z - cam.z;
      const h = Math.hypot(dx, dz);
      this.yaw = dampAngle(this.yaw, Math.atan2(-dx, -dz), 8, dt);
      this.pitch = damp(this.pitch, clamp(Math.atan2(c.y - cam.y, Math.max(h, 1)), -0.7, 0.9), 7, dt);
    }

    const cp = Math.cos(this.pitch);
    this.forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    // distance and FOV react to speed
    const speed = Math.hypot(mech.vel.x, mech.vel.z);
    const boostK = clamp(speed / 200, 0, 1);
    this.dist = damp(this.dist, 44 + boostK * 10, 5, dt);
    this.fov = damp(this.fov, BASE_FOV + boostK * 16 + (mech.dashT > 0 ? 6 : 0), 6, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // ideal camera position: behind and above, nudged to the right shoulder
    const shoulder = mech.dead ? 0 : 13 * s;
    const want = this._want.set(
      focus.x - this.forward.x * this.dist + Math.cos(this.yaw) * shoulder,
      focus.y - this.forward.y * this.dist + 8,
      focus.z - this.forward.z * this.dist - Math.sin(this.yaw) * shoulder,
    );
    // stay in front of walls
    const dir = this._dir.copy(want).sub(focus);
    const len = dir.length();
    dir.divideScalar(len);
    const hit = world.raycast(focus.x, focus.y, focus.z, dir.x, dir.y, dir.z, len + 2);
    if (hit < len + 1.5) want.copy(focus).addScaledVector(dir, Math.max(5, hit - 2.5));
    if (want.y < 2) want.y = 2;

    const cam = this.camera;
    if (!this.initialised) {
      cam.position.copy(want);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-26 * dt);
      cam.position.lerp(want, k);
    }

    // trauma shake
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const sh = this.trauma * this.trauma;
    const t = performance.now() * 0.05;
    cam.position.x += Math.sin(t * 1.3) * sh * 2.2;
    cam.position.y += Math.sin(t * 1.9 + 1) * sh * 1.6;
    cam.position.z += Math.sin(t * 1.1 + 2) * sh * 2.2;

    cam.lookAt(
      cam.position.x + this.forward.x * 100,
      cam.position.y + this.forward.y * 100,
      cam.position.z + this.forward.z * 100,
    );
    cam.rotateZ(Math.sin(t * 0.9) * sh * 0.05);
    cam.updateMatrixWorld(true);
  }
}

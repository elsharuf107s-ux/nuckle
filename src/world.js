// The battlefield: a procedural dusk city on a street grid, a sky with a planet hanging in it,
// lighting, and the collision queries the rest of the game uses.

import * as THREE from 'three';
import { clamp, mulberry32 } from './util.js';

export const ARENA = 360; // playable half-width; beyond this the pilot is pushed back
const PITCH = 120;        // street grid spacing (a 36-wide street plus an 84-wide block)
const BLOCK_INSET = 18;   // half the street width
const TILE = 18;          // world size of one repeating window texture tile
export const FLOOR_H = TILE / 4; // the window texture has four rows per tile: one row of windows is one floor

export const SUN_DIR = new THREE.Vector3(0.62, 0.3, 0.72).normalize();

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.boxes = []; // collision volumes: the standing buildings ({ minX, maxX, minZ, maxZ, top, ... }; see _buildCity)
    this.allBuildings = []; // every building ever built, standing or not (destruction.js rebuilds them between sorties)
    this.rand = mulberry32(1979);

    scene.fog = new THREE.FogExp2(0x7a4a60, 0.00115);
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildCity();
    this._buildFarCity();
    this._buildGarage();
    this._buildCatapult();
  }

  // ------------------------------------------------------------------ sky

  _buildSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uSun: { value: SUN_DIR.clone() } },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vDir;
          uniform vec3 uSun;
          float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          void main() {
            vec3 d = normalize(vDir);
            float h = clamp(d.y, -0.2, 1.0);
            vec3 horizon = vec3(0.95, 0.46, 0.38);
            vec3 mid = vec3(0.36, 0.2, 0.46);
            vec3 zenith = vec3(0.02, 0.03, 0.12);
            vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
            col = mix(col, zenith, smoothstep(0.15, 0.75, h));
            col = mix(col, vec3(0.12, 0.08, 0.14), smoothstep(0.0, -0.2, d.y));
            // stars
            vec3 cell = floor(d * 380.0);
            float r = hash(cell);
            float star = step(0.9965, r) * smoothstep(0.12, 0.5, d.y) * (0.5 + 0.5 * hash(cell + 3.1));
            col += vec3(star);
            // sun glow low on the horizon
            float s = max(dot(d, uSun), 0.0);
            col += vec3(1.0, 0.55, 0.3) * (pow(s, 24.0) * 0.55 + pow(s, 400.0) * 1.4);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);

    // A planet in the sky: the "colony drop" backdrop.
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(1100, 48, 32),
      new THREE.ShaderMaterial({
        fog: false,
        uniforms: { uLight: { value: new THREE.Vector3(0.85, 0.15, 0.55).normalize() } },
        vertexShader: `
          varying vec3 vObj; varying vec3 vN; varying vec3 vW;
          void main() {
            vObj = normalize(position);
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: `
          varying vec3 vObj; varying vec3 vN; varying vec3 vW;
          uniform vec3 uLight;
          float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
          float n(vec3 p) {
            vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
          }
          void main() {
            vec3 p = vObj * 3.0;
            float land = n(p) * 0.6 + n(p * 2.0) * 0.3 + n(p * 4.0) * 0.1;
            vec3 col = mix(vec3(0.04, 0.18, 0.5), vec3(0.22, 0.42, 0.2), smoothstep(0.52, 0.56, land));
            float cloud = n(p * 2.5 + 7.0) * 0.7 + n(p * 6.0) * 0.3;
            col = mix(col, vec3(1.0), smoothstep(0.55, 0.78, cloud) * 0.85);
            vec3 N = normalize(vN);
            float l = max(dot(N, uLight), 0.0);
            vec3 V = normalize(cameraPosition - vW);
            float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
            col = col * (0.03 + l * 1.15) + vec3(0.25, 0.5, 1.0) * rim * (0.15 + l * 0.9);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    planet.frustumCulled = false;
    this.planet = planet;
    this.planetOffset = new THREE.Vector3(-0.5, 0.3, -0.82).normalize().multiplyScalar(4300);
    this.scene.add(planet);
  }

  // ------------------------------------------------------------------ lighting

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9db2ff, 0x6a4a40, 1.6));

    const sun = new THREE.DirectionalLight(0xffc89c, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -150; c.right = 150; c.top = 150; c.bottom = -150; c.near = 10; c.far = 900;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    const fill = new THREE.DirectionalLight(0x86a0ff, 1.25);
    fill.position.set(-SUN_DIR.x * 100, 60, -SUN_DIR.z * 100);
    this.scene.add(fill);

    // One light that pops at explosions.
    this.flash = new THREE.PointLight(0xffa860, 0, 260, 1.6);
    this.scene.add(this.flash);
    this.flashT = 0;
  }

  flashAt(pos, strength = 1) {
    this.flash.position.copy(pos);
    this.flash.intensity = 900 * strength;
    this.flashT = 0.35;
  }

  // ------------------------------------------------------------------ ground

  _buildGround() {
    const size = PITCH * 34;
    const tex = this._groundTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(size / PITCH, size / PITCH);
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.05 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _groundTexture() {
    const S = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const px = S / PITCH; // pixels per world unit
    g.fillStyle = '#24262e';
    g.fillRect(0, 0, S, S);
    // blocks (the tile edge is a street centre line, so the block sits in the middle)
    g.fillStyle = '#3a3e49';
    g.fillRect(BLOCK_INSET * px, BLOCK_INSET * px, (PITCH - 2 * BLOCK_INSET) * px, (PITCH - 2 * BLOCK_INSET) * px);
    g.fillStyle = '#2f323c';
    g.fillRect((BLOCK_INSET + 3) * px, (BLOCK_INSET + 3) * px, (PITCH - 2 * BLOCK_INSET - 6) * px, (PITCH - 2 * BLOCK_INSET - 6) * px);
    // dashed centre lines on all four tile edges
    g.fillStyle = 'rgba(214,176,52,0.75)';
    for (let i = 0; i < S; i += 40) {
      g.fillRect(i, 0, 22, 3);
      g.fillRect(i, S - 3, 22, 3);
      g.fillRect(0, i, 3, 22);
      g.fillRect(S - 3, i, 3, 22);
    }
    // crosswalks beside each junction
    g.fillStyle = 'rgba(225,225,230,0.55)';
    for (let k = 0; k < 8; k++) {
      const o = (BLOCK_INSET + 2 + k * 2.1) * px;
      g.fillRect(o, 4, 6, 11);
      g.fillRect(o, S - 15, 6, 11);
      g.fillRect(4, o, 11, 6);
      g.fillRect(S - 15, o, 11, 6);
    }
    // grit
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.05)';
      g.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1 + rng() * 2);
    }
    return new THREE.CanvasTexture(cv);
  }

  // ------------------------------------------------------------------ buildings

  _windowTextures() {
    const S = 128;
    const diffuse = document.createElement('canvas');
    const glow = document.createElement('canvas');
    diffuse.width = diffuse.height = glow.width = glow.height = S;
    const d = diffuse.getContext('2d');
    const e = glow.getContext('2d');
    d.fillStyle = '#b9bcc8';
    d.fillRect(0, 0, S, S);
    e.fillStyle = '#000';
    e.fillRect(0, 0, S, S);
    const rng = mulberry32(31);
    const cols = 4, rows = 4, cw = S / cols, rh = S / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + 5, y = r * rh + 6, w = cw - 10, h = rh - 12;
        d.fillStyle = '#242a3c';
        d.fillRect(x, y, w, h);
        d.fillStyle = 'rgba(255,255,255,0.18)';
        d.fillRect(x, y, w, 2);
        if (rng() < 0.4) {
          e.fillStyle = rng() < 0.75 ? '#ffd68a' : '#9fd4ff';
          e.fillRect(x + 1, y + 1, w - 2, h - 2);
        }
      }
    }
    // floor slabs
    d.fillStyle = 'rgba(0,0,0,0.25)';
    for (let r = 0; r < rows; r++) d.fillRect(0, r * rh, S, 2);
    const a = new THREE.CanvasTexture(diffuse);
    const b = new THREE.CanvasTexture(glow);
    for (const t of [a, b]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    }
    a.colorSpace = THREE.SRGBColorSpace;
    b.colorSpace = THREE.SRGBColorSpace;
    return { map: a, emissiveMap: b };
  }

  _buildCity() {
    const { map, emissiveMap } = this._windowTextures();
    const tints = [0xffffff, 0xd8dce8, 0xe8d6c8, 0xc4ccd8, 0xd0c8d8, 0xb8c4c0];
    const sideMats = tints.map((color) => new THREE.MeshStandardMaterial({
      color, map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.8, metalness: 0.1,
    }));
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.9 });
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, fog: false });
    const rng = this.rand;
    this.cityGroup = new THREE.Group();
    this.scene.add(this.cityGroup);
    this.cityAssets = { sideMats, roofMat };

    /**
     * A building is a box from the ground to `top`, and the record is its own collision volume. `top` drops as
     * floors are destroyed (see destruction.js): `h0` is the original height, `n0` the original floor count, `n` the
     * floors standing, `floorDmg` the damage each floor has taken, `props` the roof machinery that goes down with the roof.
     */
    const addBuilding = (cx, cz, w, d, h) => {
      const ou = rng();
      const ov = Math.floor(rng() * 4) / 4; // a quarter tile at a time: the slab lines of the texture land on the floor lines
      const side = sideMats[Math.floor(rng() * sideMats.length)];
      const n0 = Math.ceil(h / FLOOR_H);
      const b = {
        minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, top: h,
        cx, cz, w, d, h0: h, n0, n: n0, ou, ov, side, floorDmg: new Float32Array(n0), props: [],
        mesh: null, crown: null, rubble: null, changed: false, lastDecal: -1, smokeUntil: -1,
      };
      const mesh = new THREE.Mesh(this.buildingGeo(b, 0, h), [side, side, roofMat, roofMat, side, side]);
      mesh.position.set(cx, h / 2, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.cityGroup.add(mesh);
      b.mesh = mesh;
      this.boxes.push(b);
      this.allBuildings.push(b);

      // rooftop machinery and aircraft-warning beacons (they come down with the roof)
      if (rng() < 0.45) {
        const bw = w * (0.2 + rng() * 0.25), bd = d * (0.2 + rng() * 0.25), bh = 2 + rng() * 4;
        const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), roofMat);
        box.position.set(cx + (rng() - 0.5) * w * 0.4, h + bh / 2, cz + (rng() - 0.5) * d * 0.4);
        box.castShadow = true;
        this.cityGroup.add(box);
        b.props.push({ mesh: box, base: h, size: Math.max(bw, bd, bh) });
      }
      if (h > 60) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 14, 6), roofMat);
        mast.position.set(cx, h + 7, cz);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), beaconMat);
        lamp.position.set(cx, h + 14.5, cz);
        this.cityGroup.add(mast, lamp);
        b.props.push({ mesh: mast, base: h, size: 3 }, { mesh: lamp, base: h, size: 1.5 });
      }
    };

    const half = PITCH / 2 - BLOCK_INSET - 2; // usable half-width of a block
    for (let i = -3; i <= 2; i++) {
      for (let j = -3; j <= 2; j++) {
        const bx = i * PITCH + PITCH / 2;
        const bz = j * PITCH + PITCH / 2;
        // keep the four blocks around the spawn as an open plaza
        if (Math.hypot(bx, bz) < 100) continue;
        const roll = rng();
        if (roll < 0.1) continue; // empty lot
        const lots = roll < 0.45 ? 1 : roll < 0.75 ? 2 : 4;
        const cells = lots === 1 ? [[0, 0, 1, 1]]
          : lots === 2 ? (rng() < 0.5 ? [[-0.5, 0, 0.5, 1], [0.5, 0, 0.5, 1]] : [[0, -0.5, 1, 0.5], [0, 0.5, 1, 0.5]])
            : [[-0.5, -0.5, 0.5, 0.5], [0.5, -0.5, 0.5, 0.5], [-0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
        for (const [ox, oz, sx, sz] of cells) {
          // Lots leave a gap of at least 16 between them (a mech is ~11 wide), so alleys are
          // either clearly passable or absent; nothing wedges a mech into a too-narrow slot.
          const w = half * 2 * sx - 16 - rng() * (sx === 1 ? 10 : 6);
          const d = half * 2 * sz - 16 - rng() * (sz === 1 ? 10 : 6);
          const tall = rng() < 0.28;
          const h = tall ? 58 + rng() * 55 : 22 + rng() * 32;
          addBuilding(bx + ox * half, bz + oz * half, w, d, h);
        }
      }
    }
  }

  /**
   * The walls of a building between heights y0 and y1, centred on its footprint and spanning y0..y1 around its middle
   * (so position it at (y0 + y1) / 2). The window texture runs on from the ground whatever the segment, so a shortened
   * building and a slab of a fallen one both keep their windows lined up.
   */
  buildingGeo(b, y0, y1) {
    const hh = y1 - y0;
    const geo = new THREE.BoxGeometry(b.w, hh, b.d);
    const uv = geo.attributes.uv;
    for (let f = 0; f < 6; f++) {
      if (f === 2 || f === 3) continue; // roof / floor
      const faceW = f < 2 ? b.d : b.w;
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        uv.setXY(k, uv.getX(k) * (faceW / TILE) + b.ou, uv.getY(k) * (hh / TILE) + y0 / TILE + b.ov);
      }
    }
    return geo;
  }

  /** Dark silhouettes beyond the arena for depth; no collision. */
  _buildFarCity() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2a3a, roughness: 1, emissive: 0x1a1420, emissiveIntensity: 0.6 });
    const rng = mulberry32(99);
    const group = new THREE.Group();
    for (let i = 0; i < 90; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = ARENA + 90 + rng() * 700;
      const w = 30 + rng() * 60, d = 30 + rng() * 60, h = 50 + rng() * 240;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(Math.cos(ang) * dist, h / 2, Math.sin(ang) * dist);
      group.add(m);
    }
    this.scene.add(group);
  }

  // ------------------------------------------------------------------ garage platform

  /** A lit turntable the mech stands on while you work in the garage. Hidden during sorties. */
  _buildGarage() {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(19, 19.8, 0.9, 56),
      new THREE.MeshStandardMaterial({ color: 0x1b2029, metalness: 0.75, roughness: 0.35 }),
    );
    disc.position.y = -0.37; // top face sits a hair above the street so feet never sink in
    disc.receiveShadow = true;
    g.add(disc);
    const glow = (r, tube, color) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, tube, 8, 72),
        new THREE.MeshBasicMaterial({ color, fog: false }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.12;
      g.add(ring);
    };
    glow(17.6, 0.3, 0x52e0ff);
    glow(11.5, 0.12, 0x2a7f99);
    glow(5.5, 0.1, 0x2a7f99);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 1.6), new THREE.MeshBasicMaterial({ color: 0x52e0ff, fog: false }));
      tick.position.set(Math.cos(a) * 14.6, 0.1, Math.sin(a) * 14.6);
      tick.rotation.y = -a;
      g.add(tick);
    }
    g.visible = false;
    this.garage = g;
    this.scene.add(g);
  }

  setGarage(on) {
    this.garage.visible = on;
  }

  // ------------------------------------------------------------------ the launch catapult

  /**
   * The catapult that opens each sortie: a deck sunk flush into the street north of the plaza, with guide rails,
   * a blast deflector, a shuttle the mech rides and a signal post. It has no collision and is hidden outside the
   * launch. The mech faces -z down the deck, from `start` to `end`.
   */
  _buildCatapult() {
    const start = 255, end = 175, len = start - end, mid = (start + end) / 2;
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a303b, metalness: 0.7, roughness: 0.45 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x161a21, metalness: 0.6, roughness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.6 });
    const box = (w, h, d, mat, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    box(15, 0.4, len + 24, metal, 0, -0.18, mid + 4);              // the deck, its top flush with the street
    box(1.6, 0.42, len + 20, darkMetal, 0, -0.17, mid + 4);         // the shuttle's slot
    for (const s of [-1, 1]) {
      box(0.8, 1.1, len + 20, metal, s * 6.9, 0.55, mid + 4);       // guide rails
      for (let i = 0; i < 12; i++) box(0.9, 0.12, 2.2, i % 2 ? darkMetal : yellow, s * 7.7, 0.04, start + 10 - i * 4); // hazard edge at the start
    }
    // rail lights that race ahead of the shuttle during the run
    const lampOff = new THREE.MeshBasicMaterial({ color: 0x23323d, fog: false });
    const lampOn = new THREE.MeshBasicMaterial({ color: 0x6fe6ff, fog: false });
    const strip = [];
    for (let i = 0; i < 14; i++) {
      const z = start - (i / 13) * len;
      for (const s of [-1, 1]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 2.4), lampOff);
        lamp.position.set(s * 6.9, 1.15, z);
        g.add(lamp);
        strip.push({ lamp, u: i / 13 });
      }
    }
    // the blast deflector, raised behind the mech
    box(17, 0.8, 11, darkMetal, 0, 4.2, start + 11, -1.05);
    box(17, 0.3, 1.2, yellow, 0, 9.1, start + 13.4, -1.05);
    // the shuttle: a block in the slot and a tow bar ahead of the toes
    const shuttle = new THREE.Group();
    const sb = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 5), darkMetal);
    sb.position.set(0, 0.3, 0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 1.1), yellow);
    bar.position.set(0, 0.35, -4.4);
    shuttle.add(sb, bar);
    g.add(shuttle);
    // the signal post: two reds, then green for go
    const post = new THREE.Group();
    post.position.set(-11, 0, start - 8); // on the far side from the launch camera, so it frames the shot instead of blocking it
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, 12, 0.6), darkMetal);
    pole.position.y = 6;
    post.add(pole);
    const off = new THREE.MeshBasicMaterial({ color: 0x2a2224, fog: false });
    const red = new THREE.MeshBasicMaterial({ color: 0xff3040, fog: false });
    const green = new THREE.MeshBasicMaterial({ color: 0x40ff80, fog: false });
    const lamps = [0, 1, 2].map((i) => {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 8), off);
      l.position.set(0.6, 11 - i * 1.8, 0);
      post.add(l);
      return l;
    });
    g.add(post);
    g.visible = false;
    this.scene.add(g);

    this.catapult = {
      group: g, start, end,
      /** Move the shuttle to `z`. */
      setShuttle(z) { shuttle.position.z = z; },
      /** The countdown (`a` 0..1: red, red, then green) and the rail lights racing ahead as the run (`run` 0..1) goes on. */
      setLights(a, run = 0) {
        const goLit = a >= 0.999;
        lamps[0].material = goLit ? green : a > 0.05 ? red : off;
        lamps[1].material = goLit ? green : a > 0.45 ? red : off;
        lamps[2].material = goLit ? green : off;
        const lead = run > 0 ? Math.min(1, run * 1.6 + 0.15) : (a > 0.66 ? 0.12 : 0);
        for (const s of strip) s.lamp.material = s.u <= lead ? lampOn : lampOff;
      },
    };
    this.catapult.setShuttle(start);
    this.catapult.setLights(0);
  }

  showCatapult(on) {
    this.catapult.group.visible = on;
    if (on) { this.catapult.setShuttle(this.catapult.start); this.catapult.setLights(0); }
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, focus, cameraPos) {
    this.sky.position.copy(cameraPos);
    this.planet.position.copy(cameraPos).add(this.planetOffset);

    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.position.set(focus.x + SUN_DIR.x * 400, SUN_DIR.y * 400, focus.z + SUN_DIR.z * 400);

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.intensity *= Math.exp(-9 * dt);
      if (this.flashT <= 0) this.flash.intensity = 0;
    }
  }

  // ------------------------------------------------------------------ collision queries

  /** Is this point inside a building or underground? */
  pointBlocked(x, y, z) {
    if (y < 0) return true;
    for (const b of this.boxes) {
      if (y < b.top && x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return true;
    }
    return false;
  }

  /** The standing building that contains this point, or null (the ground and open air are not buildings). */
  buildingAt(x, y, z) {
    if (y < 0) return null;
    for (const b of this.boxes) {
      if (y < b.top && x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
    }
    return null;
  }

  /** Height of the roof (or ground) a body of this radius can stand on, given its previous feet height. */
  supportHeight(x, z, radius, prevY) {
    let best = 0;
    const r = radius * 0.7;
    for (const b of this.boxes) {
      if (b.top > best && b.top <= prevY + 0.8 &&
          x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) best = b.top;
    }
    return best;
  }

  /**
   * Push a vertical cylinder out of any building it overlaps. Mutates pos/vel.
   * Returns the number of walls touched (the AI uses this to decide to hop over obstacles).
   */
  collide(pos, vel, radius) {
    let touched = 0;
    for (const b of this.boxes) {
      if (pos.y >= b.top - 0.3) continue; // standing on / flying over the roof
      const cx = clamp(pos.x, b.minX, b.maxX);
      const cz = clamp(pos.z, b.minZ, b.maxZ);
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      let nx, nz, push;
      if (d2 > 1e-6) {
        const dist = Math.sqrt(d2);
        nx = dx / dist; nz = dz / dist; push = radius - dist;
      } else {
        // centre is inside the footprint: leave through the nearest face
        const l = pos.x - b.minX, r = b.maxX - pos.x, f = pos.z - b.minZ, k = b.maxZ - pos.z;
        const m = Math.min(l, r, f, k);
        nx = nz = 0;
        if (m === l) nx = -1; else if (m === r) nx = 1; else if (m === f) nz = -1; else nz = 1;
        push = m + radius;
      }
      pos.x += nx * push;
      pos.z += nz * push;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
      touched++;
    }
    return touched;
  }

  /** Distance along a ray to the first building/ground hit, or Infinity. dir must be normalised. */
  raycast(ox, oy, oz, dx, dy, dz, maxT = 1000) {
    let best = maxT;
    if (dy < -1e-6) {
      const t = -oy / dy;
      if (t > 0 && t < best) best = t;
    }
    for (const b of this.boxes) {
      let t0 = 0, t1 = best;
      const slab = (o, d, lo, hi) => {
        if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
        let a = (lo - o) / d, c = (hi - o) / d;
        if (a > c) [a, c] = [c, a];
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        return t0 <= t1;
      };
      if (slab(ox, dx, b.minX, b.maxX) && slab(oy, dy, 0, b.top) && slab(oz, dz, b.minZ, b.maxZ) && t0 < best && t0 >= 0) best = t0;
    }
    return best < maxT ? best : Infinity;
  }

  /** Random open spot on a ring around the origin, clear of buildings. */
  findSpawn(minR, maxR, avoid = []) {
    for (let tries = 0; tries < 60; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > ARENA - 20 || Math.abs(z) > ARENA - 20) continue;
      if (this.pointBlocked(x, 5, z) || this._nearBox(x, z, 12)) continue;
      if (avoid.some((p) => Math.hypot(p.x - x, p.z - z) < 60)) continue;
      return { x, z };
    }
    return { x: 0, z: -minR };
  }

  /** Is there room to stand here (inside the arena, clear of every building by `margin`)? */
  isOpen(x, z, margin = 12) {
    return Math.abs(x) <= ARENA - 20 && Math.abs(z) <= ARENA - 20 && !this.pointBlocked(x, 5, z) && !this._nearBox(x, z, margin);
  }

  _nearBox(x, z, margin) {
    for (const b of this.boxes) {
      if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
    }
    return false;
  }
}

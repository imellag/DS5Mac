// The 3D controller of the website: the app's own stage (camera, poses,
// moving parts) in three.js. The page tells it which pose to show and
// which effect to play. It draws only while something can be seen and
// something moves, like the app's resting stage (ADR-0024), and lowers
// its resolution on a computer that cannot keep up.
//
// Poses are the app's (DS5Mac/UI/DesignSystem/DesignTokens.swift,
// ScenePoses): degrees, meters, and millimeters of the model, with +X to
// the player's right, +Y out of the face and +Z toward the player.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const POSES = {
  hero:      { pitch: 52, yaw: -14, distance: 0.33, target: [0, 10, 0],   fit: 175 },
  home:      { pitch: 58, yaw: 0,   distance: 0.33, target: [0, 10, 0],   fit: 170 },
  // Wider than the app's close-up: the page's text sits next to it.
  lights:    { pitch: 70, yaw: 0,   distance: 0.15, target: [0, 17, -14], fit: 140 },
  triggers:  { pitch: 138, yaw: 0,  distance: 0.28, target: [0, 0, -40],  fit: 148 },
  vibration: { pitch: 26, yaw: -10, distance: 0.34, target: [0, 8, 12],   fit: 165 },
  profiles:  { pitch: 42, yaw: 32,  distance: 0.34, target: [0, 10, 0],   fit: 175 },
};

const FIELD_OF_VIEW = 30;
/// Pixels drawn at most: a large window at 2x would draw far more than the
/// eye can tell apart on a model this size.
const PIXEL_BUDGET = 4.5e6;
/// The resolutions tried in turn while frames come too slowly.
const PIXEL_RATIOS = [2, 1.5, 1];
/// Frames measured before judging, the ones skipped after each change, and
/// the median time between frames, in milliseconds, judged too slow
/// (about 35 frames per second).
const QUALITY_SAMPLES = 45;
const QUALITY_WARMUP = 15;
const SLOW_FRAME = 28;
const CAMERA_Z = 0.5;
const ACCENT = new THREE.Color(0x3cc8f4);
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
/// A lit player LED under the clear strip: a soft, cool white with a hint
/// of lavender, a quarter of the way to white (ControllerRig).
const PLAYER_LED_GLOW = srgb(0.66, 0.68, 0.82).lerp(new THREE.Color(1, 1, 1), 0.25);
const MUTE_ORANGE = new THREE.Color(0xff9f0a);
/// The lightbar's colors in the Lights chapter, as the app's presets.
const LIGHTBAR_COLORS = [0x2b6bff, 0xff3b5c, 0x30d158, 0xbf5af2, 0x3cc8f4, 0xffb340].map((c) => new THREE.Color(c));

const radians = (degrees) => (degrees * Math.PI) / 180;
const smooth = (t) => { const c = Math.min(Math.max(t, 0), 1); return c * c * (3 - 2 * c); };

/// A ramp from black (U = 0) to white (U = 1), linear values: multiplied
/// by the lightbar color, it turns the stored strength into the glow.
function rampTexture() {
  const width = 256, data = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) {
    const value = Math.round((x / (width - 1)) * 255);
    data.set([value, value, value, 255], x * 4);
  }
  const texture = new THREE.DataTexture(data, width, 1);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/// The glow for one LED pattern (ControllerRig.glowMaterial): a bell over
/// each lit LED reaching halfway to the next, even across the line and
/// softened at its edges, faded out at both ends.
function ledGlowTexture(mask, glow) {
  const width = 256, height = 16, data = new Uint8Array(width * height * 4);
  const lit = glow.centers.filter((_, i) => (mask >> i) & 1);
  const spread = (glow.centers[1] - glow.centers[0]) * 0.42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1), v = y / (height - 1);
      const position = glow.left + u * glow.width;
      const along = Math.min(lit.reduce((sum, center) => sum + Math.exp(-(((position - center) / spread) ** 2)), 0), 1);
      const ends = smooth(u / 0.08) * smooth((1 - u) / 0.08);
      const across = 1 - smooth((Math.abs(v - 0.5) * 2 - 0.6) / 0.4);
      data.set([255, 255, 255, Math.round(along * ends * across * 255)], (y * width + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
const lerp = (a, b, t) => a + (b - a) * t;
/// Moves `current` toward `target` like a critically damped follow.
const follow = (current, target, timeConstant, dt) => target + (current - target) * Math.exp(-dt / timeConstant);

export class Stage {
  /// `frame()` returns the free area the model is framed in, in CSS pixels
  /// of the viewport: { x, y, width, height }.
  ///
  /// `onQuality(ratio)` is told every time the resolution goes down, with
  /// 0 once the lowest is still too slow.
  constructor(canvas, { frame, reduceMotion, onQuality }) {
    this.canvas = canvas;
    this.frame = frame;
    this.reduceMotion = reduceMotion;
    this.effect = null;
    this.effectTime = 0;
    this.pointer = { x: 0, y: 0 };
    this.tilt = { x: 0, y: 0 };
    this.turn = 0;
    this.visible = true;
    this.ready = false;
    this.stopped = false;
    this.onQuality = onQuality;
    this.maxPixelRatio = PIXEL_RATIOS[0];
    this.samples = [];
    this.warmup = QUALITY_WARMUP;

    // Without a graphics processor (a browser drawing WebGL in software)
    // this fails, and the page keeps its picture of the controller.
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    const environment = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    // A key from above the camera's left shoulder and a rim from behind,
    // like the app's stage lights.
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.25, 0.35, 0.4);
    const rim = new THREE.DirectionalLight(0xbfe9ff, 1.4);
    rim.position.set(0, 0.3, -0.45);
    this.scene.add(key, rim);

    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 5);
    this.camera.position.set(0, 0, CAMERA_Z);

    // The app's scene graph: the pose, the turn, then the pose's target
    // brought onto the pivot.
    this.pivot = new THREE.Group();
    this.turntable = new THREE.Group();
    this.centering = new THREE.Group();
    this.pivot.add(this.turntable);
    this.turntable.add(this.centering);
    this.scene.add(this.pivot);

    this.shown = { ...POSES.hero, target: [...POSES.hero.target] };
    this.wanted = POSES.hero;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => this.loop());
  }

  async load(url) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(new URL('../vendor/three/addons/libs/draco/', import.meta.url).href);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    this.model = gltf.scene;
    this.centering.add(this.model);

    this.nodes = {};
    this.rest = {};
    this.model.traverse((object) => {
      if (object.name) {
        this.nodes[object.name] = object;
        this.rest[object.name] = { position: object.position.clone(), quaternion: object.quaternion.clone() };
      }
      if (object.isMesh) object.userData.normalMaterial = object.material;
    });

    // The controller's lights, as the app draws them (ControllerRig): unlit
    // materials, the lightbar's glow read from its UVs, and a soft glow
    // over the lit player LEDs.
    this.lights = {
      lightbar: new THREE.MeshBasicMaterial({ map: rampTexture(), toneMapped: false }),
      ledOn: new THREE.MeshBasicMaterial({ color: srgb(0.24, 0.25, 0.32), toneMapped: false }),
      ledOff: new THREE.MeshBasicMaterial({ color: 0x000000 }),
      mute: new THREE.MeshBasicMaterial({ color: MUTE_ORANGE, toneMapped: false }),
    };
    this.ledGlow = this.makeLEDGlow();
    this.setLightbar(LIGHTBAR_COLORS[0]);
    this.setPlayerLEDs(0b00100);
    this.ready = true;
    this.lastTime = null;
    this.resize();
    this.loop();
  }

  /// The pose to fly to. With Reduce Motion it is there at once.
  show(name) {
    this.wanted = POSES[name] ?? POSES.home;
    if (this.reduceMotion) this.snap();
    this.loop();
  }

  /// Plays `name` ("lights", "triggers", "vibration", "live", "turn") or
  /// nothing. Effects are skipped with Reduce Motion, except the lights.
  play(name) {
    if (this.effect === name) return;
    this.effect = name;
    this.effectTime = 0;
    this.resetParts();
    this.loop();
  }

  setPointer(x, y) {
    this.pointer.x = x;
    this.pointer.y = y;
    this.loop();
  }

  setVisible(visible) {
    this.visible = visible;
    this.loop();
  }

  snap() {
    const w = this.wanted;
    Object.assign(this.shown, { pitch: w.pitch, yaw: w.yaw, distance: w.distance, fit: w.fit, target: [...w.target] });
  }

  /// Stops drawing for good: the page shows its picture instead.
  stop() {
    this.stopped = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
  }

  resize() {
    const width = window.innerWidth, height = window.innerHeight;
    const budget = Math.sqrt(PIXEL_BUDGET / (width * height));
    this.pixelRatio = Math.max(Math.min(window.devicePixelRatio, this.maxPixelRatio, budget), 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewHeight = height;
    this.viewWidth = width;
    if (!this.ready) return;
    this.update(0);
    this.render();
  }

  // MARK: Frame

  /// Draws frame after frame until the model is still, then rests until
  /// the page asks for something (a pose, an effect, the pointer).
  loop() {
    if (this.frameRequest || this.stopped || !this.ready || !this.visible || document.hidden) return;
    this.frameRequest = requestAnimationFrame((time) => {
      this.frameRequest = null;
      // The first frame after a rest has no time before it to measure.
      const delta = this.lastTime == null ? null : time - this.lastTime;
      this.lastTime = time;
      this.update(delta == null ? 1 / 60 : Math.min(delta / 1000, 0.1));
      this.render();
      if (delta != null) this.measure(delta);
      if (this.isStill()) {
        this.lastTime = null;
        return;
      }
      this.loop();
    });
  }

  /// Nothing playing and everything arrived where it was going.
  isStill() {
    if (this.effect && !(this.effect === 'turn' && this.reduceMotion)) return false;
    const near = (a, b, tolerance) => Math.abs(a - b) < tolerance;
    const s = this.shown, w = this.wanted;
    return near(s.pitch, w.pitch, 0.01) && near(s.yaw, w.yaw, 0.01)
      && near(s.distance, w.distance, 1e-5) && near(s.fit, w.fit, 0.01)
      && s.target.every((value, i) => near(value, w.target[i], 0.01))
      && near(this.tilt.x, this.tiltGoal.x, 0.01) && near(this.tilt.y, this.tiltGoal.y, 0.01)
      && near(this.turn, Math.round(this.turn / (2 * Math.PI)) * 2 * Math.PI, 1e-4);
  }

  /// The time between frames, judged on its median so that one hitch
  /// (a texture made, a chapter's first frame) does not count.
  measure(delta) {
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    this.samples.push(delta);
    if (this.samples.length < QUALITY_SAMPLES) return;
    const median = this.samples.sort((a, b) => a - b)[Math.floor(this.samples.length / 2)];
    this.samples = [];
    if (median <= SLOW_FRAME) return;
    const lower = PIXEL_RATIOS.find((ratio) => ratio < this.pixelRatio - 0.01);
    if (lower) {
      this.maxPixelRatio = lower;
      this.resize();
      this.warmup = QUALITY_WARMUP;
      this.onQuality?.(lower);
    } else {
      // Nothing lower to try: stop measuring and let the page decide.
      this.warmup = Infinity;
      this.onQuality?.(0);
    }
  }

  update(dt) {
    // The pose follows the wanted one with a little inertia, like the
    // app's springs.
    const s = this.shown, w = this.wanted, k = this.reduceMotion ? 0.0001 : 0.28;
    s.pitch = follow(s.pitch, w.pitch, k, dt);
    s.yaw = follow(s.yaw, w.yaw, k, dt);
    s.distance = follow(s.distance, w.distance, k, dt);
    s.fit = follow(s.fit, w.fit, k, dt);
    for (let i = 0; i < 3; i++) s.target[i] = follow(s.target[i], w.target[i], k, dt);

    // The pointer tilts the model a few degrees; the profiles chapter turns it.
    const tiltGoal = this.reduceMotion ? { x: 0, y: 0 } : { x: this.pointer.y * 6, y: this.pointer.x * 10 };
    this.tiltGoal = tiltGoal;
    this.tilt.x = follow(this.tilt.x, tiltGoal.x, 0.5, dt);
    this.tilt.y = follow(this.tilt.y, tiltGoal.y, 0.5, dt);
    if (this.effect === 'turn' && !this.reduceMotion) this.turn += radians(12) * dt;
    else this.turn = follow(this.turn, Math.round(this.turn / (2 * Math.PI)) * 2 * Math.PI, 0.6, dt);

    this.effectTime += dt;
    this.updateEffect(dt);

    const area = this.frame();
    const distance = this.distanceFor(s, area);
    const metersPerPixel = (2 * distance * Math.tan(radians(FIELD_OF_VIEW) / 2)) / this.viewHeight;
    const offsetX = area.x + area.width / 2 - this.viewWidth / 2;
    const offsetY = area.y + area.height / 2 - this.viewHeight / 2;
    this.pivot.position.set(offsetX * metersPerPixel, -offsetY * metersPerPixel, CAMERA_Z - distance);
    this.pivot.quaternion.setFromEuler(new THREE.Euler(radians(s.pitch), radians(s.yaw), 0, 'XYZ'));
    this.turntable.quaternion.setFromEuler(new THREE.Euler(radians(this.tilt.x), radians(this.tilt.y) + this.turn, 0, 'XYZ'));
    this.centering.position.set(-s.target[0] / 1000, -s.target[1] / 1000, -s.target[2] / 1000);
    if (this.shake) this.pivot.position.add(this.shake);
  }

  /// The camera backs away until `fit` millimeters fill the free area.
  distanceFor(pose, area) {
    const perPixelAtOneMeter = (2 * Math.tan(radians(FIELD_OF_VIEW) / 2)) / this.viewHeight;
    const usable = Math.max(Math.min(area.width, area.height * 1.5) * 0.8, 1);
    return Math.max(pose.distance, pose.fit / 1000 / (usable * perPixelAtOneMeter));
  }

  render() {
    if (this.ready) this.renderer.render(this.scene, this.camera);
  }

  // MARK: Effects

  updateEffect() {
    const t = this.effectTime;
    this.shake = null;
    switch (this.effect) {
      case 'lights': {
        // The lightbar fades through the presets; the player LEDs count up.
        const step = t / 1.4;
        const index = Math.floor(step) % LIGHTBAR_COLORS.length;
        const next = (index + 1) % LIGHTBAR_COLORS.length;
        const mix = Math.min(Math.max((step % 1 - 0.7) / 0.3, 0), 1);
        this.setLightbar(LIGHTBAR_COLORS[index].clone().lerp(LIGHTBAR_COLORS[next], mix));
        const patterns = [0b00100, 0b01010, 0b10101, 0b11011, 0b11111];
        this.setPlayerLEDs(patterns[Math.floor(t / 1.4) % patterns.length]);
        this.setMute(Math.floor(t / 2.8) % 2 === 1);
        break;
      }
      case 'triggers': {
        // Both triggers pressed in turn, slowly at first: the resistance.
        const left = Math.max(0, Math.sin(t * 1.6));
        const right = Math.max(0, Math.sin(t * 1.6 + Math.PI));
        this.setTrigger('Trigger_L2', left);
        this.setTrigger('Trigger_R2', right);
        break;
      }
      case 'vibration': {
        // A heartbeat: two beats, then a pause.
        const beat = t % 1.2;
        const strength = Math.exp(-((beat - 0.08) ** 2) / 0.002) + 0.7 * Math.exp(-((beat - 0.32) ** 2) / 0.002);
        const amount = 0.0007 * strength;
        this.shake = new THREE.Vector3((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount, 0);
        break;
      }
      case 'live': {
        // Buttons one after another, sticks in circles, triggers breathing.
        const buttons = ['Button_Cross', 'Button_Circle', 'Button_Triangle', 'Button_Square', 'Dpad_Up', 'Dpad_Right', 'Dpad_Down', 'Dpad_Left', 'Button_R1', 'Button_L1'];
        const pressed = buttons[Math.floor(t * 2) % buttons.length];
        for (const name of buttons) this.press(name, name === pressed && (t * 2) % 1 < 0.6);
        this.setStick('Stick_Left', Math.cos(t * 1.3) * 0.8, Math.sin(t * 1.3) * 0.8);
        this.setStick('Stick_Right', -Math.sin(t * 0.9) * 0.6, Math.cos(t * 0.9) * 0.6);
        this.setTrigger('Trigger_L2', Math.abs(Math.sin(t * 0.8)));
        this.setTrigger('Trigger_R2', Math.abs(Math.cos(t * 0.8)));
        break;
      }
      default:
        break;
    }
  }

  resetParts() {
    if (!this.ready) return;
    for (const [name, rest] of Object.entries(this.rest)) {
      const node = this.nodes[name];
      node.position.copy(rest.position);
      node.quaternion.copy(rest.quaternion);
    }
    for (const name of Object.keys(this.pressedLooks ?? {})) this.press(name, false);
    if (this.effect !== 'lights') {
      this.setLightbar(LIGHTBAR_COLORS[0]);
      this.setPlayerLEDs(0b00100);
      this.setMute(false);
    }
  }

  meshes(name) {
    const list = [];
    this.nodes?.[name]?.traverse((object) => { if (object.isMesh) list.push(object); });
    return list;
  }

  /// The light line glows in `color`, strongest at the top of its sides
  /// (the strength the export stored in its U coordinate).
  setLightbar(color) {
    if (!this.lights) return;
    this.lights.lightbar.color.copy(color);
    for (const mesh of this.meshes('Lightbar')) mesh.material = this.lights.lightbar;
  }

  /// `mask` bit 0 is the player's leftmost LED. An unlit LED matches the
  /// dark stretches of the line around it.
  setPlayerLEDs(mask) {
    // Called every frame by the lights effect: a new map would make three.js
    // check the material again each time.
    if (!this.lights || mask === this.ledMask) return;
    this.ledMask = mask;
    for (let i = 0; i < 5; i++) {
      const on = (mask >> i) & 1;
      for (const mesh of this.meshes(`PlayerLED_${i + 1}`)) mesh.material = on ? this.lights.ledOn : this.lights.ledOff;
    }
    const glow = this.ledGlow;
    if (!glow) return;
    glow.mesh.visible = mask !== 0;
    glow.textures[mask] ??= ledGlowTexture(mask, glow);
    glow.mesh.material.map = glow.textures[mask];
    glow.mesh.material.needsUpdate = true;
  }

  setMute(on) {
    if (!this.lights) return;
    for (const mesh of this.meshes('Button_Mute')) mesh.material = on ? this.lights.mute : mesh.userData.normalMaterial;
  }

  /// One flat, see-through plane over the straight run of the light line,
  /// just above it (ControllerRig.makeLEDGlow): one plane, so its parts are
  /// never drawn in a changing order.
  makeLEDGlow() {
    const group = this.nodes.PlayerLEDs;
    const leds = [1, 2, 3, 4, 5].map((i) => this.nodes[`PlayerLED_${i}`]);
    if (!group || leds.some((led) => !led?.geometry)) return null;
    const boxes = leds.map((led) => {
      led.geometry.computeBoundingBox();
      return led.geometry.boundingBox.clone().translate(led.position);
    });
    const centers = boxes.map((box) => (box.min.x + box.max.x) / 2);
    const ledWidth = boxes[0].max.x - boxes[0].min.x;
    const left = centers[0] - ledWidth * 1.5, right = centers[4] + ledWidth * 1.5;
    const top = Math.max(...boxes.map((box) => box.max.y));
    const geometry = new THREE.PlaneGeometry(right - left, boxes[0].max.z - boxes[0].min.z);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: PLAYER_LED_GLOW, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((left + right) / 2, top + 0.0003, (boxes[2].min.z + boxes[2].max.z) / 2);
    mesh.renderOrder = 1;
    group.add(mesh);
    return { mesh, left, width: right - left, centers, textures: {} };
  }

  /// The app's press: 1 mm down along the part's -Y, with the accent.
  press(name, down) {
    const node = this.nodes?.[name], rest = this.rest?.[name];
    if (!node || !rest) return;
    node.position.copy(rest.position);
    if (down) node.position.y -= name.includes('1') ? 0.0012 : 0.001;
    this.pressedLooks ??= {};
    if (!!this.pressedLooks[name] === down) return;
    this.pressedLooks[name] = down;
    node.traverse((mesh) => {
      if (!mesh.isMesh) return;
      mesh.userData.normalMaterial ??= mesh.material;
      if (down) {
        // Made once per part and kept: the live chapter presses a button
        // twice a second.
        mesh.userData.pressedMaterial ??= (() => {
          const glowing = (Array.isArray(mesh.userData.normalMaterial) ? mesh.userData.normalMaterial : [mesh.userData.normalMaterial]).map((m) => {
            const copy = m.clone();
            copy.emissive = ACCENT.clone();
            copy.emissiveIntensity = 0.6;
            return copy;
          });
          return glowing.length === 1 ? glowing[0] : glowing;
        })();
        mesh.material = mesh.userData.pressedMaterial;
      } else {
        mesh.material = mesh.userData.normalMaterial;
      }
    });
  }

  /// 0 released, 1 fully pressed: up to 18 degrees around the hinge.
  setTrigger(name, value) {
    const node = this.nodes?.[name], rest = this.rest?.[name];
    if (!node || !rest) return;
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.min(Math.max(value, 0), 1) * radians(18));
    node.quaternion.copy(rest.quaternion).multiply(turn);
  }

  /// -1 to 1 on both axes, +y up: up to 20 degrees of tilt.
  setStick(name, x, y) {
    const node = this.nodes?.[name], rest = this.rest?.[name];
    if (!node || !rest) return;
    const amount = Math.min(Math.hypot(x, y), 1);
    node.quaternion.copy(rest.quaternion);
    if (amount < 0.001) return;
    const axis = new THREE.Vector3(-y, 0, -x).normalize();
    node.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, amount * radians(20)));
  }

  /// For tests: one frame drawn now, as a PNG data URL.
  snapshot() {
    this.update(1 / 60);
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}

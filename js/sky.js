// Cielo: estrellas reales (catálogo HYG vía d3-celestial) colocadas por su ascensión
// recta y declinación y giradas según el tiempo sidéreo, constelaciones con nombres
// en español, la Luna en su posición y fase reales, y una bóveda azul que aparece
// al acercarse al suelo con la cámara inclinada.
import * as THREE from 'three';
import { gmst, moonPosition, moonPhase } from './astro.js';
import { latLonToVec3, toScreen, isOccluded } from './geo.js';

const STAR_R = 100;
const MOON_DIST = 22; // radios terrestres (la real es ~60; se acerca para que se vea)
const MOON_R = 0.2;

// gl_Position.z = w → siempre en el plano lejano: "en el infinito", sin recortes
const starVertex = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aSeed;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
    float tw = 0.85 + 0.15 * sin(uTime * (1.3 + aSeed * 2.0) + aSeed * 40.0);
    gl_PointSize = aSize * uPixelRatio;
    vColor = aColor;
    vAlpha = tw * clamp(aSize / 2.2, 0.35, 1.0);
  }
`;
const starFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, r);
    a = a * a * vAlpha * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * a, a);
  }
`;
const farVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const skyVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 p = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    gl_Position = p.xyww;
  }
`;
const skyFragment = /* glsl */ `
  uniform vec3 sunDir;
  uniform float uFade;
  varying vec3 vWorld;
  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    vec3 up = normalize(cameraPosition);
    float elev = dot(dir, up);
    float sunElev = dot(up, sunDir);
    float day = smoothstep(-0.18, 0.10, sunElev);
    float t = pow(clamp(elev, 0.0, 1.0), 0.45);
    vec3 col = mix(vec3(0.62, 0.78, 0.98), vec3(0.08, 0.27, 0.72), t);
    float toSun = max(dot(dir, sunDir), 0.0);
    float sunset = 1.0 - smoothstep(0.0, 0.3, abs(sunElev));
    col = mix(col, vec3(1.0, 0.52, 0.22), sunset * pow(toSun, 3.0) * (1.0 - t) * 0.9);
    col += vec3(1.0, 0.93, 0.8) * (pow(toSun, 1500.0) * 8.0 + pow(toSun, 60.0) * 0.4) * day;
    gl_FragColor = vec4(col * (0.3 + 0.7 * day), clamp(uFade * day, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

const moonVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const moonFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    float l = max(dot(normalize(vNormalW), sunDir), 0.0);
    vec3 col = c * (pow(l, 0.8) * 1.25 + 0.012);   // + luz cenicienta
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Color aproximado de una estrella a partir de su índice B-V. */
function bvColor(bv) {
  const t = THREE.MathUtils.clamp((bv + 0.3) / 2.0, 0, 1);
  const c = new THREE.Color();
  if (t < 0.35) c.setRGB(0.68 + t, 0.78 + t * 0.5, 1.0);
  else if (t < 0.6) c.setRGB(1.0, 0.96, 0.88);
  else c.setRGB(1.0, 0.82 - (t - 0.6) * 0.4, 0.6 - (t - 0.6) * 0.5);
  return c;
}

function labelSprite(text) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '500 26px "Instrument Sans", system-ui, sans-serif';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 16;
  c.width = w; c.height = 40;
  g.font = font;
  g.fillStyle = 'rgba(170, 200, 255, 0.75)';
  g.textBaseline = 'middle';
  g.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false }));
  s.scale.set((w / 40) * 0.022, 0.022, 1);
  s.renderOrder = -5;
  return s;
}

export class Sky {
  constructor({ scene, camera, renderer, earth, time, isMobile }) {
    this.scene = scene;
    this.camera = camera;
    this.earth = earth;
    this.time = time;
    this.isMobile = isMobile;
    this.pixelRatio = renderer.getPixelRatio();

    // Grupo inercial: sigue a la cámara (sin paralaje) y gira con el tiempo sidéreo
    this.celestial = new THREE.Group();
    scene.add(this.celestial);

    this.starUniforms = { uTime: { value: 0 }, uPixelRatio: { value: this.pixelRatio }, uOpacity: { value: 1 } };
    this.constellationsOn = true;
    this.moonOn = true;
    this.moonInfo = null;
    this.buildMoon();
    this.buildSkyDome();
    this.load();
  }

  async load() {
    // Textura de fondo tenue (vía láctea/estrellas débiles), girando con el cielo
    new THREE.TextureLoader().load('./assets/textures/night-sky.png', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(STAR_R * 1.1, 48, 24),
        new THREE.ShaderMaterial({
          uniforms: { map: { value: t } },
          vertexShader: farVertex,
          fragmentShader: `uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb * 0.22, 1.0); }`,
          side: THREE.BackSide,
          depthTest: false,
          depthWrite: false,
        }),
      );
      m.renderOrder = -20;
      this.celestial.add(m);
    });

    try {
      const res = await fetch('./assets/sky/sky.json');
      const sky = await res.json();
      this.buildStars(sky.stars);
      this.buildConstellations(sky.lines, sky.names);
    } catch (e) {
      console.warn('[sky]', e);
    }
  }

  buildStars(stars) {
    const n = stars.length;
    const pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3), seed = new Float32Array(n);
    const v = new THREE.Vector3();
    stars.forEach(([ra, dec, mag, bv], i) => {
      latLonToVec3(dec, ra, STAR_R, v);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = THREE.MathUtils.clamp((6.2 - mag) * 0.85, 0.9, 6.5) * (this.isMobile ? 0.85 : 1);
      const c = bvColor(bv);
      col.set([c.r, c.g, c.b], i * 3);
      seed[i] = Math.random();
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: starVertex,
      fragmentShader: starFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    pts.renderOrder = -19;
    pts.frustumCulled = false;
    this.celestial.add(pts);
  }

  buildConstellations(lines, names) {
    const pos = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const [, segs] of lines) {
      for (const seg of segs) {
        for (let i = 0; i < seg.length - 1; i++) {
          latLonToVec3(seg[i][1], seg[i][0], STAR_R, a);
          latLonToVec3(seg[i + 1][1], seg[i + 1][0], STAR_R, b);
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.11 } },
      vertexShader: `void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform float uOpacity; void main(){ gl_FragColor = vec4(vec3(0.45, 0.62, 1.0) * uOpacity, uOpacity); }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.lines.renderOrder = -18;
    this.lines.frustumCulled = false;
    this.celestial.add(this.lines);

    // Nombres de las constelaciones principales (rango 1–2) para no saturar
    this.labels = new THREE.Group();
    for (const [, name, ra, dec, rank] of names) {
      if (rank > 2) continue;
      const s = labelSprite(name);
      latLonToVec3(dec, ra, 20, s.position);
      this.labels.add(s);
    }
    this.celestial.add(this.labels);
    this.applyConstellations();
  }

  setConstellations(on) { this.constellationsOn = on; this.applyConstellations(); }
  applyConstellations() {
    if (this.lines) this.lines.visible = this.constellationsOn;
    if (this.labels) this.labels.visible = this.constellationsOn;
  }

  buildMoon() {
    const tex = new THREE.TextureLoader().load('./assets/textures/moon.jpg', (t) => { t.colorSpace = THREE.SRGBColorSpace; });
    const geo = new THREE.SphereGeometry(MOON_R, 48, 32);
    geo.rotateY(-Math.PI / 2); // la cara visible (longitud 0) mira hacia +z → hacia la Tierra con lookAt
    this.moon = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, sunDir: this.earth.uniforms.sunDir },
      vertexShader: moonVertex,
      fragmentShader: moonFragment,
    }));
    this.moon.renderOrder = -4;
    this.scene.add(this.moon);
  }

  setMoon(on) { this.moonOn = on; }

  buildSkyDome() {
    this.skyUniforms = { sunDir: this.earth.uniforms.sunDir, uFade: { value: 0 } };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.scene.add(this.dome);
  }

  /** Color del horizonte para la niebla de las teselas (según la altura del sol sobre la cámara). */
  horizonColor(out) {
    const up = this.camera.position.clone().normalize();
    const sunElev = up.dot(this.earth.uniforms.sunDir.value);
    const day = THREE.MathUtils.smoothstep(sunElev, -0.18, 0.1);
    return out.setRGB(0.015 + 0.48 * day, 0.02 + 0.6 * day, 0.04 + 0.85 * day);
  }

  update(dt, h) {
    const date = new Date(this.time.now());
    this.starUniforms.uTime.value += dt;
    this.celestial.position.copy(this.camera.position);
    this.celestial.rotation.y = -gmst(date);
    // De día y a ras de suelo la bóveda azul tapa las estrellas
    const fade = 1 - THREE.MathUtils.smoothstep(h, 0.004, 0.07);
    this.skyUniforms.uFade.value = fade;
    this.dome.position.copy(this.camera.position);
    this.dome.visible = fade > 0.001;
    if (this.labels) this.labels.visible = this.constellationsOn && h > 0.3;

    // Luna (solo cuando la cámara está lejos: hace falta un plano lejano amplio)
    const { lat, lon, distKm } = moonPosition(date);
    latLonToVec3(lat, lon, MOON_DIST, this.moon.position);
    this.moon.lookAt(0, 0, 0);
    this.moon.visible = this.moonOn && h > 0.3;
    this.moonInfo = { distKm, ...moonPhase(date) };
  }

  pick(x, y, radius) {
    if (!this.moon.visible || !this.moonInfo) return null;
    const { w, h } = { w: innerWidth, h: innerHeight };
    const sp = toScreen(this.moon.position, this.camera, w, h);
    if (sp.behind || isOccluded(this.moon.position, this.camera.position)) return null;
    // radio aparente de la Luna en pantalla
    const d = this.camera.position.distanceTo(this.moon.position);
    const rPx = (MOON_R / d) * (h / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.hypot(sp.x - x, sp.y - y);
    if (dist > rPx + radius) return null;
    const m = this.moonInfo;
    return {
      dist: Math.max(0, dist - rPx),
      html: `
        <div class="tt-kicker" style="--c:#e8e4d8"><span class="tt-dot"></span>La Luna</div>
        <div class="tt-title">${m.name} · ${Math.round(m.fraction * 100)} % iluminada</div>
        <div class="tt-meta">A ${Math.round(m.distKm).toLocaleString('es-ES')} km de la Tierra<br>Posición y fase reales (tamaño y distancia no a escala)</div>`,
    };
  }
}

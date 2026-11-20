// Planeta: shader día/noche con terminador suave, brillo especular en océanos,
// halo atmosférico y cielo estrellado.
import * as THREE from 'three';

const TEX = './assets/textures/';

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Sombreado compartido por el globo base y las teselas de satélite.
// day: color de día; nightUv: coordenadas equirectangulares para luces y máscara de agua.
export const SHADE_PARS = /* glsl */ `
  vec4 gNight = vec4(0.0);      // luces de alta resolución de la teselas (rgb, mezcla); las rellena el shader de teselas
  uniform sampler2D nightMap;
  uniform sampler2D waterMap;
  uniform sampler2D cloudMap;   // nubes en directo: proyectan sombra sobre el suelo
  uniform float uCloudShadow;
  uniform vec3 sunDir;
  uniform vec3 uMoonPos;        // posición real de la Luna (radios terrestres): eclipses
  uniform float uTime;

  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }

  // Fracción del Sol visible desde un punto de la superficie (1 = pleno sol, 0 = totalidad)
  float sunVisible(vec3 P) {
    vec3 m = uMoonPos - P;
    float dm = length(m);
    float rm = 0.2727 / dm;          // radio angular de la Luna
    float rs = 0.004652;             // radio angular del Sol
    vec3 mn = m / dm;
    if (dot(mn, sunDir) < 0.99) return 1.0;
    // ángulo pequeño: asin(|a×b|) es mucho más preciso en la GPU que acos(a·b)
    float sep = asin(min(length(cross(mn, sunDir)), 1.0));
    if (sep >= rs + rm) return 1.0;
    float o = rm >= rs ? clamp((rs + rm - sep) / (2.0 * rs), 0.0, 1.0)
                       : clamp((rs + rm - sep) / (2.0 * rm), 0.0, 1.0) * (rm * rm) / (rs * rs);
    return 1.0 - o * 0.985;
  }

  // N: normal de la esfera (día/noche, agua); Nt: normal del relieve (sombreado de montañas)
  vec3 shadeEarthT(vec3 day, vec2 nightUv, vec3 N, vec3 Nt, vec3 V) {
    float cosSun = dot(N, sunDir);
    float dayMix = smoothstep(-0.16, 0.20, cosSun);
    vec3 night = mix(texture2D(nightMap, nightUv).rgb, gNight.rgb, gNight.a);
    float water = texture2D(waterMap, nightUv).r;

    // Sombra de las nubes (el eclipse se aplica al final, sobre el color ya sombreado)
    float sunlight = 1.0;
    if (uCloudShadow > 0.0 && cosSun > 0.0) {
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-6, 0.0, 0.0));
      vec3 north = cross(N, east);
      vec3 sunT = sunDir - N * cosSun;
      float shift = 0.0016 / max(cosSun, 0.15);           // nubes a ~10 km: la sombra se alarga con el sol bajo
      float cl = max(cos(asin(N.y)), 0.2);
      vec2 off = vec2(dot(sunT, east) / (6.2832 * cl), dot(sunT, north) / 3.1416) * shift;
      float c = texture2D(cloudMap, nightUv + off).r;
      sunlight *= 1.0 - smoothstep(0.35, 0.9, c) * 0.4 * uCloudShadow;
    }

    // Cara diurna: lambert suavizado; con el sol bajo la luz se vuelve cálida (atraviesa más atmósfera)
    float light = clamp(dot(Nt, sunDir), 0.0, 1.0);
    vec3 warm = mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.0, 0.3, cosSun));
    vec3 dayCol = day * (0.10 + 1.15 * pow(light, 0.75) * sunlight) * warm;

    // Destello del sol en el agua, con oleaje que se mueve
    vec2 wp = nightUv * vec2(2400.0, 1200.0);
    vec3 Nw = normalize(N + 0.035 * vec3(vnoise(wp + uTime * 0.6) - 0.5, 0.0, vnoise(wp.yx * 1.3 - uTime * 0.5) - 0.5));
    vec3 H = normalize(sunDir + V);
    float nh = max(dot(Nw, H), 0.0);
    float spec = (pow(nh, 160.0) * 0.5 + pow(nh, 18.0) * 0.05) * water;
    spec *= smoothstep(0.08, 0.45, dot(N, V)) * smoothstep(0.05, 0.35, cosSun) * sunlight;
    dayCol += vec3(1.0, 0.88, 0.68) * spec;

    // Cara nocturna: luces de ciudades cálidas sobre un azul muy oscuro.
    float lightMask = smoothstep(0.012, 0.38, night.r);
    vec3 lights = vec3(1.0, 0.68, 0.36) * pow(lightMask, 1.2) * 2.6;
    vec3 nightCol = night * 0.03 + day * 0.004 + vec3(0.001, 0.003, 0.009) + lights;

    vec3 col = mix(nightCol, dayCol, dayMix);

    // Atmósfera vista de canto: azul de día, anaranjada en el terminador (dispersión de Rayleigh)
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    float litRim = smoothstep(-0.25, 0.45, cosSun);
    vec3 haze = mix(vec3(1.0, 0.45, 0.2), vec3(0.32, 0.58, 1.0), smoothstep(-0.05, 0.35, cosSun));
    return mix(col, haze, fres * (0.04 + 0.26 * litRim));
  }
  vec3 shadeEarth(vec3 day, vec2 nightUv, vec3 N, vec3 V) { return shadeEarthT(day, nightUv, N, N, V); }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D photoMap;   // foto real de ayer (NASA GIBS)
  uniform float uPhoto;
  ${SHADE_PARS}
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 day = mix(texture2D(dayMap, vUv).rgb, texture2D(photoMap, vUv).rgb, uPhoto);
    gl_FragColor = vec4(shadeEarth(day, vUv, N, V), 1.0);
    #include <colorspace_fragment>
  }
`;

const atmoVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Se dibuja la cara trasera de una esfera algo mayor: el halo nace en el limbo
// del planeta y se desvanece hacia fuera.
const atmoFragment = /* glsl */ `
  uniform vec3 sunDir;
  uniform float limb;
  uniform float uFade;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float rim = -dot(N, V);                       // 0 en el borde exterior, ~limb en el limbo
    float k = clamp(rim / limb, 0.0, 1.0);
    float glow = pow(k, 3.4) * smoothstep(1.25, 0.9, k); // más fino y suave: sin aspecto de plástico
    float s = dot(N, sunDir);
    float lit = mix(0.06, 1.0, smoothstep(-0.35, 0.35, s));
    vec3 blue = vec3(0.30, 0.62, 1.0);
    vec3 dusk = vec3(1.0, 0.5, 0.25);
    vec3 col = mix(dusk, blue, smoothstep(-0.12, 0.30, s));
    // Contraluz: si el sol está detrás del planeta, el borde se enciende (amanecer visto desde el espacio)
    float mu = dot(normalize(vPosW - cameraPosition), sunDir);
    float mie = pow(max(mu, 0.0), 10.0) * smoothstep(-0.45, 0.05, s);
    col = mix(col, vec3(1.0, 0.78, 0.55), clamp(mie, 0.0, 1.0) * 0.7);
    float a = glow * (lit + mie * 1.2) * 0.42 * uFade;
    gl_FragColor = vec4(col * a, a);
    #include <colorspace_fragment>
  }
`;

function solidTexture(r, g, b) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function createEarth({ scene, renderer, manager, isMobile, onTextureError }) {
  const loader = new THREE.TextureLoader(manager); // críticas: la pantalla de carga las espera
  const bgLoader = new THREE.TextureLoader(); // el resto llega después, sin bloquear
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const uniforms = {
    dayMap: { value: solidTexture(14, 38, 72) },
    nightMap: { value: solidTexture(0, 0, 0) },
    waterMap: { value: solidTexture(0, 0, 0) },
    photoMap: { value: solidTexture(0, 0, 0) },
    uPhoto: { value: 0 },
    cloudMap: { value: solidTexture(0, 0, 0) },
    uCloudShadow: { value: 0 },
    uMoonPos: { value: new THREE.Vector3(0, 0, -60) },
    uTime: { value: 0 },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
  };

  let waterSampler = null;

  const load = (file, key, { srgb = true, onLoad, critical = false } = {}) => {
    (critical ? loader : bgLoader).load(
      TEX + file,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = aniso;
        if (key) uniforms[key].value = t;
        onLoad?.(t);
      },
      undefined,
      () => onTextureError?.(file),
    );
  };

  // Primero versiones ligeras (≈115 KB) para enseñar el planeta cuanto antes;
  // las de 4096 px y la máscara de agua se cargan en segundo plano.
  load('earth-day-1k.jpg', 'dayMap', { critical: true });
  load('earth-night-1k.jpg', 'nightMap', { critical: true });
  const loadFull = () => {
    load('earth-water.jpg', 'waterMap', { srgb: false, onLoad: (t) => { waterSampler = makeSampler(t.image); } });
    load(isMobile ? 'earth-day-1k.jpg' : 'earth-day-4k.jpg', 'dayMap');
    load('earth-night-4k.jpg', 'nightMap');
  };

  const seg = isMobile ? [96, 64] : [160, 100];
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, seg[0], seg[1]),
    new THREE.ShaderMaterial({ uniforms, vertexShader: earthVertex, fragmentShader: earthFragment }),
  );
  scene.add(earth);

  const ATMO_R = 1.11;
  const atmoUniforms = {
    sunDir: uniforms.sunDir,
    limb: { value: Math.sqrt(1 - 1 / (ATMO_R * ATMO_R)) },
    uFade: { value: 1 },
  };
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(ATMO_R, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: atmoUniforms,
      vertexShader: atmoVertex,
      fragmentShader: atmoFragment,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(atmosphere);

  // Sombra de la Luna (eclipses solares). El centro y el tamaño se calculan en la CPU
  // (doble precisión: los ángulos del Sol y la Luna son diminutos) y aquí solo se pinta.
  const shadowU = {
    sunDir: uniforms.sunDir,
    uQ: { value: new THREE.Vector3(1, 0, 0) },   // punto de la superficie bajo el eje de la sombra
    uRu: { value: 0.016 },                       // radio de la umbra (cuerda, radios terrestres)
    uRp: { value: 0.5 },                         // radio de la penumbra
    uK: { value: 0 },                            // intensidad (0 = no hay eclipse)
  };
  const eclipse = new THREE.Mesh(
    new THREE.SphereGeometry(1.0012, seg[0], seg[1]),
    new THREE.ShaderMaterial({
      uniforms: shadowU,
      vertexShader: earthVertex,
      fragmentShader: `
        uniform vec3 sunDir;
        uniform vec3 uQ;
        uniform float uRu, uRp, uK;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vec3 N = normalize(vNormalW);
          float d = length(N - uQ);
          float o = d < uRu ? 1.0 : pow(clamp(1.0 - (d - uRu) / (uRp - uRu), 0.0, 1.0), 1.4);
          float a = o * uK * smoothstep(-0.12, 0.15, dot(N, sunDir));
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.01, a * 0.94);
        }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  eclipse.renderOrder = 1.9; // encima del suelo y las teselas, debajo de nubes y marcadores
  eclipse.visible = false;
  scene.add(eclipse);

  const _d = new THREE.Vector3(), _p = new THREE.Vector3();
  /** Recalcula la sombra a partir de la posición real de la Luna (radios terrestres). */
  function updateEclipse(moon) {
    const sun = uniforms.sunDir.value;
    _d.copy(sun).negate();
    const b = moon.dot(_d);
    if (b > 0) { eclipse.visible = false; return; } // la Luna no está entre el Sol y la Tierra
    const dm = moon.length();
    const rm = 0.2727 / dm, rs = 0.004652;
    // Punto del eje más cercano al centro de la Tierra y su distancia
    _p.copy(moon).addScaledVector(_d, -b);
    const miss = _p.length();
    const rp = (rs + rm) * dm; // radio de la penumbra en la Tierra
    if (miss > 1 + rp) { eclipse.visible = false; return; }
    const c = moon.lengthSq() - 1, disc = b * b - c;
    if (disc >= 0) _p.copy(moon).addScaledVector(_d, -b - Math.sqrt(disc));
    shadowU.uQ.value.copy(_p).normalize();
    shadowU.uRu.value = Math.max(Math.abs(rm - rs) * dm, 0.004);
    shadowU.uRp.value = rp;
    // Si el eje no toca la Tierra (eclipse parcial), la sombra es más débil cuanto más lejos pasa
    shadowU.uK.value = disc >= 0 ? (rm >= rs ? 1 : 0.85) : Math.max(0, 1 - (miss - 1) / rp) * 0.8;
    eclipse.visible = true;
  }

  return {
    mesh: earth,
    updateEclipse,
    uniforms,
    /** Carga las texturas de alta resolución (se llama cuando ya se ve el planeta). */
    loadFull,
    /** Atenúa el halo cuando la cámara se mete en la atmósfera (zoom cercano). */
    setAltitude(h) { atmoUniforms.uFade.value = THREE.MathUtils.smoothstep(h, 0.06, 0.22); },
    setSunDirection(v) { uniforms.sunDir.value.copy(v).normalize(); },
    /** true/false si la máscara está cargada; null si aún no. */
    isWater(lat, lon) { return waterSampler ? waterSampler(lat, lon) : null; },
  };
}

function makeSampler(img) {
  try {
    const w = img.width, h = img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    return (lat, lon) => {
      const x = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
      return data[(y * w + x) * 4] > 128;
    };
  } catch {
    return null;
  }
}

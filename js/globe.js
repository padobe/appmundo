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
  uniform sampler2D nightMap;
  uniform sampler2D waterMap;
  uniform vec3 sunDir;

  // N: normal de la esfera (día/noche, agua); Nt: normal del relieve (sombreado de montañas)
  vec3 shadeEarthT(vec3 day, vec2 nightUv, vec3 N, vec3 Nt, vec3 V) {
    float cosSun = dot(N, sunDir);
    // Mezcla día/noche: transición ancha (crepúsculo civil + náutico ≈ 12°)
    float dayMix = smoothstep(-0.16, 0.20, cosSun);
    vec3 night = texture2D(nightMap, nightUv).rgb;
    float water = texture2D(waterMap, nightUv).r;

    // Cara diurna: lambert suavizado
    float light = clamp(dot(Nt, sunDir), 0.0, 1.0);
    vec3 dayCol = day * (0.10 + 1.15 * pow(light, 0.75));

    // Destello del sol en el agua
    vec3 H = normalize(sunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 140.0) * water;
    spec *= smoothstep(0.08, 0.45, dot(N, V)) * smoothstep(0.05, 0.35, cosSun); // sin destellos rasantes
    dayCol += vec3(1.0, 0.88, 0.68) * spec * 0.45;

    // Cara nocturna: luces de ciudades cálidas sobre un azul muy oscuro.
    // Las luces son casi blancas y el relieve es azul sin apenas rojo → el canal rojo las aísla.
    float lightMask = smoothstep(0.012, 0.38, night.r);
    vec3 lights = vec3(1.0, 0.68, 0.36) * pow(lightMask, 1.2) * 2.6;
    vec3 nightCol = night * 0.03 + day * 0.004 + vec3(0.001, 0.003, 0.009) + lights;

    vec3 col = mix(nightCol, dayCol, dayMix);

    // Toque anaranjado en el terminador
    float twilight = exp(-pow((cosSun - 0.01) / 0.06, 2.0));
    col += vec3(1.0, 0.38, 0.12) * twilight * 0.004;

    // Bruma atmosférica en el borde del disco (solo en la parte iluminada)
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    float litRim = smoothstep(-0.25, 0.45, cosSun);
    return mix(col, vec3(0.32, 0.58, 1.0), fres * (0.06 + 0.62 * litRim));
  }
  vec3 shadeEarth(vec3 day, vec2 nightUv, vec3 N, vec3 V) { return shadeEarthT(day, nightUv, N, N, V); }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  ${SHADE_PARS}
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    gl_FragColor = vec4(shadeEarth(texture2D(dayMap, vUv).rgb, vUv, N, V), 1.0);
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
    float glow = pow(k, 2.2) * smoothstep(1.25, 0.9, k);
    float s = dot(N, sunDir);
    float lit = mix(0.07, 1.0, smoothstep(-0.35, 0.35, s));
    vec3 blue = vec3(0.30, 0.62, 1.0);
    vec3 dusk = vec3(1.0, 0.52, 0.28);
    vec3 col = mix(dusk, blue, smoothstep(-0.12, 0.30, s));
    float a = glow * lit * 1.15 * uFade;
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

  return {
    mesh: earth,
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

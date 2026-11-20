// Capa: nubes reales (composición global de satélites geoestacionarios, cada 3 h)
// de clouds.matteason.co.uk. Esfera algo mayor que la Tierra, iluminada por el sol.
import * as THREE from 'three';

const URL_DESKTOP = 'https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg';
const URL_MOBILE = 'https://clouds.matteason.co.uk/images/2048x1024/clouds.jpg';
const REFRESH_MS = 60 * 60 * 1000;

const vertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float uFade;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    float c = texture2D(map, vUv).r;
    float a = smoothstep(0.12, 0.9, c) * 0.85 * uFade;
    if (a < 0.01) discard;
    float s = dot(normalize(vNormalW), sunDir);
    float lit = smoothstep(-0.12, 0.30, s);
    vec3 dayCol = vec3(0.96, 0.97, 1.0) * (0.22 + 0.58 * clamp(s, 0.0, 1.0));
    vec3 col = mix(vec3(0.012, 0.018, 0.03), dayCol, lit);
    col = mix(col, vec3(1.0, 0.55, 0.3), exp(-pow(s / 0.08, 2.0)) * 0.35);  // nubes rosadas al atardecer
    gl_FragColor = vec4(col, a * mix(0.55, 1.0, lit));
    #include <colorspace_fragment>
  }
`;

export class CloudsLayer {
  id = 'clouds';
  name = 'Nubes';

  constructor(ctx) {
    this.ctx = ctx;
    this.uniforms = {
      map: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) },
      sunDir: ctx.earth.uniforms.sunDir,
      uFade: { value: 0 },
    };
    this.uniforms.map.value.needsUpdate = true;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.008, ctx.isMobile ? 96 : 144, ctx.isMobile ? 64 : 96),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: vertex,
        fragmentShader: fragment,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 1.5;
    this.mesh.visible = false;
    ctx.scene.add(this.mesh);
    this.loaded = false;
    this.visible = true;
    this.fadeIn = 0;
  }

  start() {
    this.load();
    setInterval(() => this.load(), REFRESH_MS);
  }

  load() {
    const url = this.ctx.isMobile ? URL_MOBILE : URL_DESKTOP;
    new THREE.TextureLoader().setCrossOrigin('anonymous').load(
      url,
      (t) => {
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = 4;
        const old = this.uniforms.map.value;
        this.uniforms.map.value = t;
        old.dispose();
        this.loaded = true;
        this.ctx.ui.sourceOk(this.id);
      },
      undefined,
      () => this.ctx.ui.sourceError(this.id, 'No se pudieron cargar las nubes'),
    );
  }

  setVisible(on) { this.visible = on; }

  update(dt) {
    // Aparece suavemente al cargar y se desvanece al acercarse al suelo
    const target = this.loaded && this.visible ? 1 : 0;
    this.fadeIn += (target - this.fadeIn) * Math.min(1, dt * 2);
    const h = this.ctx.camera.position.length() - 1;
    const near = THREE.MathUtils.smoothstep(h, 0.12, 0.5);
    this.uniforms.uFade.value = this.fadeIn * near;
    this.mesh.visible = this.uniforms.uFade.value > 0.01;
  }
}

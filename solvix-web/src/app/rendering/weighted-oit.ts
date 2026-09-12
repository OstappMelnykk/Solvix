import * as THREE from 'three';

// Weighted Blended Order-Independent Transparency (McGuire & Bavoil 2013).
//
// Why this exists: plain WebGL alpha blending draws transparent triangles
// in whatever order the GPU submits them, and three.js only helps by
// sorting whole OBJECTS back-to-front by their origin - not per pixel. With
// the imported STL reference and the voxel fill both translucent and
// overlapping in depth, that per-object sort is unstable: which one "wins"
// a given pixel flips as the camera orbits, so the render visibly swaps
// which surface reads as in-front from one frame to the next. Merging STL
// and voxel geometry into one combined mesh (briefly considered) would NOT
// fix this - the GPU still rasterizes and blends triangles in submission
// order, not depth order, no matter whose geometry they came from.
//
// Weighted Blended OIT sidesteps sorting entirely: every transparent
// fragment is accumulated into a sum (weighted by how opaque it is) instead
// of blended one-at-a-time in a specific order, so the result is the same
// regardless of draw order or camera angle. The tradeoff (accepted here,
// explicitly, per the "do the best version, I trust you" go-ahead) is that
// relative depth ordering WITHIN the transparent set is only approximate,
// not exact - correct for the actual problem (angle-dependent instability),
// not for perfect depth-correct transparency, which WebGL cannot do without
// sorting every triangle every frame anyway.
//
// Implementation shape - 2 single-target passes instead of 1 MRT pass:
// the "real" algorithm renders accum+revealage simultaneously via multiple
// render targets in one draw. Browser support for per-attachment
// (indexed) blend functions is inconsistent, and MRT would require every
// tagged material's fragment shader to explicitly write 2 outputs (a
// shader-injection problem for materials we don't want to hand-fork, like
// MeshStandardMaterial's full PBR chunk pipeline). Instead this renders the
// SAME tagged objects twice, once per target, changing only the GL blend
// function between passes (both blend modes below are achievable with
// plain fixed-function blending - no custom shader needed on the tagged
// materials themselves, so a lit MeshStandardMaterial keeps its real
// lighting/vertex-color output untouched):
//   accum target (RGBA16F): blendSrc=SRC_ALPHA, blendDst=ONE, additive.
//     Accumulates color*alpha into .rgb and alpha into .a (the sum of
//     weights, used to normalize the average in the composite pass).
//   reveal target (RGBA8, cleared to 1.0): blendSrc=ZERO,
//     blendDst=ONE_MINUS_SRC_ALPHA, additive. Each draw multiplies the
//     existing value by (1 - alpha), so after every tagged object has
//     drawn, it holds the product of (1 - alpha) across all of them - the
//     fraction of the background that should still show through.
// Weight function: plain weight=1 (every fragment counted equally,
// regardless of its own alpha or depth) - the simplest variant in the
// original paper, chosen deliberately because it needs no per-fragment
// shader math at all (see above), and because it is exactly
// camera/scale-independent, which is the actual complaint being fixed.
// (Depth- or alpha-weighted variants exist and rank near/far transparent
// surfaces slightly better, but need a custom fragment shader on every
// tagged material to compute the weight - not attempted here.)
//
// Both accum and reveal targets share ONE THREE.DepthTexture, populated by
// an initial opaque "background" pass (everything NOT tagged for OIT,
// which is nearly everything: floor grid, axes, lights' helpers, voxel
// edges/nodes/highlight, the zone-color overlay, and the STL reference
// when in wireframe mode). Accum/reveal render with depth TEST on but
// depth WRITE off, so transparent fragments correctly hide behind opaque
// geometry (a wall in front of the voxel grid still occludes it) without
// transparent fragments occluding each other (the entire point).
//
// Visibility isolation uses plain `.visible` toggling on actual renderable
// leaf objects (Mesh/Line/Points - InstancedMesh/BatchedMesh are Mesh
// subclasses so `instanceof THREE.Mesh` already covers them), never
// `THREE.Layers`: the same live THREE.Scene is also rendered by OTHER
// cameras this class knows nothing about (SixViewOverlayComponent,
// ZonePaintingComponent's panels), which would silently stop seeing
// layer-restricted objects if this tagged them with a dedicated OIT layer.
// Toggling `.visible` on leaves only (never on a parent Group) matches how
// the voxel preview's own Group mixes a tagged BatchedMesh fill with
// untagged edges/nodes/highlight as SIBLINGS in the same group - toggling
// the container would take all of them with it.

const WEIGHTED_OIT_FLAG = 'weightedOit';

// Call once, right after constructing a material, to opt it into the OIT
// pipeline below. Only the STL reference's solid-mode material and the
// voxel fill material are tagged - everything else (edges/nodes/highlight,
// the zone overlay, wireframe STL) is thin enough, and rendered often
// enough on TOP of the fill rather than genuinely self-overlapping, that
// the existing simple depthWrite:false + renderOrder scheme already
// handles it without needing the extra render passes this costs.
export function markForWeightedOit(material: THREE.Material): void {
  material.userData[WEIGHTED_OIT_FLAG] = true;
}

function isWeightedOit(material: THREE.Material | readonly THREE.Material[]): boolean {
  const first = Array.isArray(material) ? material[0] : material;
  return first?.userData?.[WEIGHTED_OIT_FLAG] === true;
}

type LeafObject = THREE.Mesh | THREE.Line | THREE.Points;

function isRenderableLeaf(object: THREE.Object3D): object is LeafObject {
  return object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points;
}

function collectLeaves(scene: THREE.Scene): LeafObject[] {
  const leaves: LeafObject[] = [];
  scene.traverse(object => {
    if (isRenderableLeaf(object)) {
      leaves.push(object);
    }
  });
  return leaves;
}

function uniqueMaterialsOf(leaves: readonly LeafObject[]): THREE.Material[] {
  const seen = new Set<THREE.Material>();
  for (const leaf of leaves) {
    const materials = Array.isArray(leaf.material) ? leaf.material : [leaf.material];
    materials.forEach(material => seen.add(material));
  }
  return [...seen];
}

// Every material property this class temporarily overrides while a tagged
// material is drawn into the accum/reveal targets, saved so it can be put
// back exactly as the rest of the app (opacity sliders, etc.) left it -
// this class must never be the one leaving a material in a different state
// than it found it in once render() returns.
interface SavedBlendState {
  readonly blending: THREE.Blending;
  readonly blendEquation: THREE.BlendingEquation;
  readonly blendSrc: THREE.BlendingSrcFactor;
  readonly blendDst: THREE.BlendingDstFactor;
  readonly blendSrcAlpha: THREE.BlendingSrcFactor | null;
  readonly blendDstAlpha: THREE.BlendingDstFactor | null;
  readonly depthWrite: boolean;
}

const COMPOSITE_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Deliberately ignores modelViewMatrix/projectionMatrix - this quad's
    // own [-1,1] positions already ARE clip-space coordinates, the same
    // "raw fullscreen triangle" idiom three.js's own postprocessing Pass
    // uses, so no camera is actually driving this draw.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT_SHADER = `
  uniform sampler2D tBackground;
  uniform sampler2D tAccum;
  uniform sampler2D tReveal;
  varying vec2 vUv;
  void main() {
    vec4 accum = texture2D(tAccum, vUv);
    // Any of accum's RGBA channels would do - the reveal target was
    // cleared to 1.0 and every draw multiplied all 4 channels by the same
    // (1 - alpha) factor identically (a single, non-separate blend
    // function applies to RGBA together).
    float reveal = texture2D(tReveal, vUv).r;
    vec3 backgroundColor = texture2D(tBackground, vUv).rgb;
    // accum.a is the sum of weights (weight=1 per fragment, see the file
    // header) that landed on this pixel - dividing by it turns the raw sum
    // in accum.rgb back into a weighted AVERAGE color.
    vec3 averageColor = accum.rgb / max(accum.a, 1e-5);
    vec3 finalColor = averageColor * (1.0 - reveal) + backgroundColor * reveal;
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

export class WeightedOitRenderer {
  private readonly depthTexture: THREE.DepthTexture;
  private readonly backgroundTarget: THREE.WebGLRenderTarget;
  private readonly accumTarget: THREE.WebGLRenderTarget;
  private readonly revealTarget: THREE.WebGLRenderTarget;

  private readonly compositeScene: THREE.Scene;
  private readonly compositeCamera: THREE.OrthographicCamera;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly compositeQuad: THREE.Mesh;

  // Restored on every tagged material after each frame's accum/reveal
  // passes - see SavedBlendState above.
  private readonly savedBlendState = new Map<THREE.Material, SavedBlendState>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.depthTexture = new THREE.DepthTexture(1, 1);

    this.backgroundTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: this.depthTexture, depthBuffer: true });
    this.accumTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: this.depthTexture,
      depthBuffer: true
    });
    this.revealTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: this.depthTexture, depthBuffer: true });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBackground: { value: null },
        tAccum: { value: null },
        tReveal: { value: null }
      },
      vertexShader: COMPOSITE_VERTEX_SHADER,
      fragmentShader: COMPOSITE_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false
    });
    this.compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.compositeQuad.frustumCulled = false;
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(this.compositeQuad);
    this.compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.backgroundTarget.setSize(w, h);
    this.accumTarget.setSize(w, h);
    this.revealTarget.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const leaves = collectLeaves(scene);
    const oitLeaves = leaves.filter(leaf => isWeightedOit(leaf.material));

    if (oitLeaves.length === 0) {
      // Nothing tagged is even in the scene right now (e.g. no voxel
      // preview built yet, STL in wireframe mode) - the whole point of
      // this class is moot, so skip straight to an ordinary direct render
      // rather than paying for 3 extra passes for nothing.
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }

    const normalLeaves = leaves.filter(leaf => !isWeightedOit(leaf.material));

    // Snapshot every leaf's real visibility up front - some are already
    // hidden for unrelated reasons (the click-highlight mesh when nothing
    // is selected, six-view's own hiddenDuringView toggling, the "show
    // cubes" checkbox), and this class must restore exactly that, never
    // force something on that the rest of the app deliberately hid.
    const originalVisibility = new Map<LeafObject, boolean>();
    for (const leaf of leaves) {
      originalVisibility.set(leaf, leaf.visible);
    }

    const prevAutoClear = this.renderer.autoClear;
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.autoClear = false;

    try {
      // --- Pass 1: background (everything opaque, plus anything NOT
      // tagged for OIT) - also the pass that populates the shared depth
      // texture the next two passes test (but don't write) against. ---
      for (const leaf of oitLeaves) {
        leaf.visible = false;
      }
      this.renderer.setRenderTarget(this.backgroundTarget);
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.renderer.clear(true, true, true);
      this.renderer.render(scene, camera);

      // --- Pass 2: accum - only the tagged objects, additive weighted
      // blend into an HDR target. ---
      for (const leaf of oitLeaves) {
        leaf.visible = originalVisibility.get(leaf)!;
      }
      for (const leaf of normalLeaves) {
        leaf.visible = false;
      }
      this.applyBlendState(oitLeaves, 'accum');
      this.renderer.setRenderTarget(this.accumTarget);
      this.renderer.setClearColor(0x000000, 0);
      // Depth is NOT cleared here - it must keep pass 1's opaque depth so
      // these transparent fragments correctly test against (without
      // writing into) it.
      this.renderer.clear(true, false, false);
      this.renderer.render(scene, camera);

      // --- Pass 3: reveal - same objects, same visibility, only the blend
      // function changes (multiplicative, into a target pre-cleared to
      // white/1.0). ---
      this.applyBlendState(oitLeaves, 'reveal');
      this.renderer.setRenderTarget(this.revealTarget);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear(true, false, false);
      this.renderer.render(scene, camera);

      for (const leaf of normalLeaves) {
        leaf.visible = originalVisibility.get(leaf)!;
      }

      // --- Pass 4: composite - a fullscreen quad blends the 3 targets
      // straight onto the real backbuffer. ---
      this.renderer.setRenderTarget(null);
      this.compositeMaterial.uniforms['tBackground'].value = this.backgroundTarget.texture;
      this.compositeMaterial.uniforms['tAccum'].value = this.accumTarget.texture;
      this.compositeMaterial.uniforms['tReveal'].value = this.revealTarget.texture;
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.compositeScene, this.compositeCamera);
    } finally {
      this.restoreBlendState(oitLeaves);
      for (const leaf of leaves) {
        leaf.visible = originalVisibility.get(leaf)!;
      }
      this.renderer.setRenderTarget(null);
      this.renderer.autoClear = prevAutoClear;
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
    }
  }

  dispose(): void {
    this.backgroundTarget.dispose();
    this.accumTarget.dispose();
    this.revealTarget.dispose();
    this.depthTexture.dispose();
    this.compositeMaterial.dispose();
    this.compositeQuad.geometry.dispose();
  }

  private applyBlendState(leaves: readonly LeafObject[], mode: 'accum' | 'reveal'): void {
    for (const material of uniqueMaterialsOf(leaves)) {
      if (!this.savedBlendState.has(material)) {
        this.savedBlendState.set(material, {
          blending: material.blending,
          blendEquation: material.blendEquation,
          blendSrc: material.blendSrc,
          blendDst: material.blendDst,
          blendSrcAlpha: material.blendSrcAlpha,
          blendDstAlpha: material.blendDstAlpha,
          depthWrite: material.depthWrite
        });
      }
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.depthWrite = false;
      if (mode === 'accum') {
        // color*alpha + dst*1, alpha*1 + dst*1 - see the file header's
        // "accum target" bullet.
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneFactor;
        material.blendSrcAlpha = THREE.OneFactor;
        material.blendDstAlpha = THREE.OneFactor;
      } else {
        // color*0 + dst*(1-alpha) - see the file header's "reveal target"
        // bullet. The source color is thrown away entirely (blendSrc=0);
        // only alpha, via the destination factor, matters here.
        material.blendSrc = THREE.ZeroFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = THREE.ZeroFactor;
        material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      }
    }
  }

  private restoreBlendState(leaves: readonly LeafObject[]): void {
    for (const material of uniqueMaterialsOf(leaves)) {
      const saved = this.savedBlendState.get(material);
      if (!saved) {
        continue;
      }
      material.blending = saved.blending;
      material.blendEquation = saved.blendEquation;
      material.blendSrc = saved.blendSrc;
      material.blendDst = saved.blendDst;
      material.blendSrcAlpha = saved.blendSrcAlpha;
      material.blendDstAlpha = saved.blendDstAlpha;
      material.depthWrite = saved.depthWrite;
      this.savedBlendState.delete(material);
    }
  }
}

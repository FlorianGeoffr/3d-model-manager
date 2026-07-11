/**
 * In-browser GLB viewer (Task 8). Loaded exclusively via
 * `React.lazy(() => import("@/components/viewer/ModelViewer"))` from
 * `ViewerTab` — this is the lazy-chunk boundary that keeps three.js/R3F/drei
 * out of the main bundle (Global Constraints "BUNDLE RULE"), so this module
 * (and anything it imports) must stay a `default export` and must not be
 * imported eagerly anywhere else.
 *
 * Deviation from SPEC "Frontend" viewer paragraph (controller-approved, see
 * `.superpowers/sdd/m2-constraints.md`): no drei `<Stage>` and no
 * `<Environment preset=…>`/`files=…` -- both fetch HDRs from a CDN at
 * runtime and this app must work fully offline/self-hosted. That constraint
 * does NOT rule out image-based lighting generally: `<Environment>` only
 * takes the network-fetching `EnvironmentCube` path `if (files || preset)`
 * (`@react-three/drei/core/Environment.js`); given `<Lightformer>` children
 * and neither prop, it renders those emissive planes into a local cube
 * render target instead -- real IBL, zero network. That's what the rig below
 * uses, plus real directional lights and ACES Filmic tone mapping (now
 * applied in the postprocessing composer, see `scene/Effects.tsx`), so PBR
 * materials (authored assuming IBL) get specular response and the model
 * reads as solid instead of flat and chalky.
 *
 * ARCHITECTURE (B1 "toggle-fix core"): every combinable part stays mounted
 * for as long as it's in `parts`, whether or not its checklist checkbox is
 * checked -- toggling a checkbox only flips a `<group visible>` flag inside
 * `GltfPart`, it never adds/removes that part's subtree. Two library facts
 * forced this design:
 *
 *  1. `<Canvas>` wraps ALL of its children in exactly ONE internal
 *     `<Suspense>`. If a newly-checked part's `useGLTF` suspends, R3F hides
 *     the WHOLE already-committed scene until that one GLB resolves, then
 *     un-hides it -- which re-fires every layout effect underneath,
 *     including `Bounds`'s, and jumps the camera. Checking one more part
 *     must not blank parts that already loaded, so each part gets its OWN
 *     `<Suspense>` (`GltfPart`'s per-part wrapper below), not a shared one.
 *  2. drei's `Center`/`Resize` re-measure in a `useLayoutEffect` whose deps
 *     do NOT include their children -- toggling which parts render would
 *     never trigger a re-measure on its own. `BoundsRefitter` below is the
 *     explicit re-measure path, driven off `loadedCount` (how many parts
 *     have actually finished loading), not off visibility.
 *
 * Visibility toggles are therefore deliberately cheap: `THREE.Box3.
 * expandByObject` (which every `Box3.setFromObject` call -- `Center`,
 * `Resize`, `Bounds`'s default `refresh()` -- goes through) ignores
 * `.visible`, so hidden parts still count toward the combined bounding box.
 * Showing/hiding a part never changes framing, and `BoundsRefitter` only
 * ever refits when `loadedCount` changes (a part finishing its GLB load),
 * never on a plain checkbox click.
 */
import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Bounds,
  Center,
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  Resize,
  useBounds,
  useGLTF,
} from "@react-three/drei";
import type { LightingRig } from "@/components/viewer/lighting";
import type { SceneStats, ViewerToolsState } from "@/components/viewer/tools";
import type { ViewerPart } from "@/components/viewer/viewable";
import { ViewerEffects } from "@/components/viewer/scene/Effects";
import { CameraLayers, PlateGrid } from "@/components/viewer/scene/PlateGrid";

// A 1-unit box, used as `Resize`'s `box3` while nothing has finished loading
// yet (`allBox` is `null`) -- `Resize` divides by the box's largest
// dimension to compute its scale, and an empty/zero-size box would divide by
// zero or `-Infinity`. Never mutated; shared across renders.
const UNIT_BOX = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));

function ownedMaterialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function forEachMesh(object: THREE.Object3D, fn: (mesh: THREE.Mesh) => void) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material) fn(mesh);
  });
}

// A tiny local class -- same rationale as `ViewerErrorBoundary` in
// `ViewerStage.tsx` (no hook form for error boundaries, no
// `react-error-boundary` dependency). Scoped to ONE part's subtree: a
// corrupt/unparseable GLB now only takes out its own `<group>`, not the
// combined scene every other checked part renders into, and not the whole
// `ModelViewer` (which `ViewerErrorBoundary` still guards for a crash that
// isn't part-scoped, e.g. a lighting/Canvas-level throw). Renders `null` on
// error rather than a placeholder card -- there's no per-part slot in the
// canvas layout to put one, and the part simply not appearing is enough of a
// signal alongside the still-working parts around it.
class PartErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/**
 * One combinable GLB part. Unifies the old `GltfModel`/`RecoloredModel`
 * split -- every mount now OWNS its materials (clones each mesh's material
 * once, geometry and textures stay shared with drei's `useGLTF` cache) so a
 * `color` can always be applied/cleared imperatively without ever touching
 * the shared cache materials (which would bleed the color into every other
 * mount of the same content-addressed blob). The original material is
 * stashed on the clone's `userData.__source` so clearing a color can restore
 * it exactly instead of needing a second network round-trip or a re-clone.
 *
 * Also measures the part's own native-mm `Box3` and triangle count once, in
 * the same `useMemo` pass, while the clone is still unparented -- reported
 * upward via `onLoaded` so `ModelViewer` can union every loaded part's box
 * into the combined `Resize`/`Bounds` target without each part fighting over
 * its own separate `Center`/`Resize` (which would destroy their relative
 * positions -- see the header comment on the scene graph below).
 */
function GltfPart({
  id,
  url,
  color,
  visible,
  onLoaded,
}: {
  id: number;
  url: string;
  color: string | undefined;
  visible: boolean;
  onLoaded: (id: number, box: THREE.Box3, triangles: number) => void;
}) {
  const { scene } = useGLTF(url);

  const { object, box, triangles } = useMemo(() => {
    const cloned = scene.clone(true);
    let triCount = 0;
    forEachMesh(cloned, (mesh) => {
      const clone = (material: THREE.Material) => {
        const owned = material.clone(); // never mutate the shared cache material
        owned.userData.__source = material;
        return owned;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);

      const geometry = mesh.geometry;
      const index = geometry.index;
      triCount += index ? index.count / 3 : (geometry.attributes.position?.count ?? 0) / 3;
    });
    // Measured while `cloned` is still unparented, so this is the part's
    // native mm bounding box -- no Resize/Center/group scaling applied yet.
    const nativeBox = new THREE.Box3().setFromObject(cloned);
    return { object: cloned, box: nativeBox, triangles: triCount };
  }, [scene]);

  useLayoutEffect(() => {
    onLoaded(id, box, triangles);
  }, [id, box, triangles, onLoaded]);

  // Dispose the materials WE cloned above when this part is unmounted -- R3F
  // does not auto-dispose externally-created `<primitive>` objects, so
  // without this every mount would leak owned materials. Geometries and
  // textures are NOT disposed here: they're still owned by drei's `useGLTF`
  // cache and may be shared with other mounts of the same url.
  useEffect(() => {
    return () => {
      forEachMesh(object, (mesh) => {
        ownedMaterialsOf(mesh).forEach((material) => material.dispose());
      });
    };
  }, [object]);

  const invalidate = useThree((state) => state.invalidate);

  // Recolor as an imperative traversal over the owned materials, so a color
  // change never re-clones the scene. Clearing `color` restores each
  // material's `.color` from the `__source` stashed above.
  useEffect(() => {
    forEachMesh(object, (mesh) => {
      ownedMaterialsOf(mesh).forEach((material) => {
        const std = material as THREE.MeshStandardMaterial;
        if (!std.color) return;
        if (color) {
          std.color.set(color);
        } else {
          const source = material.userData.__source as THREE.MeshStandardMaterial | undefined;
          if (source?.color) std.color.copy(source.color);
        }
      });
    });
    invalidate();
  }, [object, color, invalidate]);

  return (
    <group visible={visible}>
      <primitive object={object} />
    </group>
  );
}

// Tone mapping itself now lives in the postprocessing composer (see
// `scene/Effects.tsx`'s `<ToneMapping mode={ToneMappingMode.ACES_FILMIC}>`)
// -- `EffectComposer` renders the scene into an offscreen target, and three
// only honors `gl.toneMapping` when rendering to the default framebuffer, so
// an imperative `gl.toneMapping` assignment here would be a no-op (worse,
// `EffectComposer` forces `gl.toneMapping = NoToneMapping` on mount, so it'd
// actively fight the composer). `toneMappingExposure` is unaffected by that
// split: it lives on the renderer, not a scene prop, so it can't go through
// `<Canvas gl={{...}}>` (that object is only applied once at construction
// and won't re-apply when the lighting preset changes at runtime), and the
// composer's `ToneMapping` effect reads it via three's uniform upload same
// as the old imperative renderer path did. Setting it imperatively here on
// every `exposure` change (and nudging `invalidate` since the canvas is
// `frameloop="demand"`) is the only way a preset switch actually shows up.
function Exposure({ exposure }: { exposure: number }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    gl.toneMappingExposure = exposure;
    invalidate();
  }, [gl, exposure, invalidate]);

  return null;
}

/** Re-measures and refits the camera as parts finish loading -- `Bounds`'s
 * own layout effect only re-runs on window resize (`observe`) or first
 * mount, and `Resize`/`Center` don't watch their children either, so nothing
 * else would re-frame the camera as a second/third part's GLB arrives.
 * Fires ONLY on `loadedCount` changing (a part finishing its load), never on
 * a visibility toggle -- toggling a checked part neither adds nor removes it
 * from `loadedParts`, so this intentionally does not run then. */
function BoundsRefitter({ loadedCount }: { loadedCount: number }) {
  const api = useBounds();
  useLayoutEffect(() => {
    if (loadedCount > 0) api.refresh().clip().fit();
    // `api` is included for the lint rule's sake -- it's a `useMemo` inside
    // `Bounds` keyed on the camera/controls/margin, so in practice it's
    // stable across re-renders and this still only actually refits when
    // `loadedCount` changes.
  }, [loadedCount, api]);
  return null;
}

/**
 * `parts` renders one GLB per entry inside a single shared `<Bounds>` /
 * `<Resize>` / `<Center>` stack so multiple mesh parts (Workstream A
 * "multi-part combined view") appear together as one scene, each keeping its
 * own local coordinates relative to the others. Wrapping each part in its
 * OWN `Center`/`Resize` instead would destroy those relative positions (each
 * part would get re-centered and re-scaled independently) -- there must be
 * exactly one wrapper around the whole group, grounding and normalizing the
 * COMBINED bounding box. Each part carries a stable `id` (the source file
 * id) used as the React key -- two files can resolve to the same `url`
 * (blobs are content-addressed by hash), so keying on `url` would collide;
 * keying on `id` keeps them distinct. An optional `color` (M8 G2) recolors
 * that part non-destructively. `background` replaces the previous
 * hard-coded studio gray -- see `background.ts` for the preset/theme
 * resolution that produces it. `lighting` selects the intensities/exposure/
 * contact-shadow toggle -- see `lighting.ts` for the preset resolution.
 *
 * Every part in `parts` is ALWAYS rendered (see the file header) -- `part.
 * visible` toggles a `<group visible>`, it never mounts/unmounts the part.
 * `loadedParts` tracks the parts that have actually finished loading (keyed
 * by id, pruned when a part disappears from `parts` entirely -- e.g. the
 * underlying file set changed), independent of which are currently visible,
 * so the combined bounding box used by `Resize`/`Bounds` stays stable across
 * plain visibility toggles.
 */
export default function ModelViewer({
  parts,
  background,
  lighting,
  tools,
  plateSize,
  onStats,
}: {
  parts: ViewerPart[];
  background: string;
  lighting: LightingRig;
  tools: ViewerToolsState;
  plateSize: number;
  onStats?: (stats: SceneStats | null) => void;
}) {
  const [loadedParts, setLoadedParts] = useState<Map<number, { box: THREE.Box3; triangles: number }>>(
    () => new Map(),
  );

  const onLoaded = useCallback((id: number, box: THREE.Box3, triangles: number) => {
    setLoadedParts((prev) => {
      const existing = prev.get(id);
      if (existing && existing.triangles === triangles && existing.box.equals(box)) return prev;
      const next = new Map(prev);
      next.set(id, { box, triangles });
      return next;
    });
  }, []);

  // Prune parts that dropped out of `parts` entirely (not merely hidden) --
  // e.g. the model's file set changed under an already-mounted viewer.
  useEffect(() => {
    const ids = new Set(parts.map((part) => part.id));
    setLoadedParts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!ids.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [parts]);

  const loadedCount = loadedParts.size;

  const allBox = useMemo(() => {
    if (loadedParts.size === 0) return null;
    const union = new THREE.Box3();
    for (const { box } of loadedParts.values()) union.union(box);
    return union;
  }, [loadedParts]);

  // The SAME normalization factor `<Resize box3=…>` below computes
  // internally (`1 / max(box dimensions)`) -- kept here too so `PlateGrid`
  // can convert its own raw-mm measurements (plate size, cell/section size)
  // into the same normalized scene units `Resize` puts the model into,
  // without either of them reaching into the other's internals. Only
  // meaningful once `allBox` exists; `PlateGrid` is gated on `allBox` below
  // so this value is never rendered from while it's still the 1-unit
  // fallback.
  const s = useMemo(() => {
    const box = allBox ?? UNIT_BOX;
    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    return maxDimension > 0 ? 1 / maxDimension : 1;
  }, [allBox]);

  // Reports the combined mm-scale bounding box + triangle count of every
  // currently VISIBLE, loaded part -- "how big is this print?" for
  // `ViewerStage`'s stats overlay chip. Native GLB units are mm (see
  // `viewable.ts`'s header / the backend's `convert.py` rescale), so
  // `loadedParts`' boxes need no further conversion. `null` when nothing
  // visible has finished loading. The ref guard skips the callback when the
  // computed value hasn't actually changed (field-equal, not reference
  // equal) -- `onStats` is expected to feed a `setState`, and calling it
  // with an equivalent-but-new object every render would loop forever.
  const lastStatsRef = useRef<SceneStats | null>(null);
  useEffect(() => {
    if (!onStats) return;

    const union = new THREE.Box3();
    let triangles = 0;
    let any = false;
    for (const part of parts) {
      if (!part.visible) continue;
      const loaded = loadedParts.get(part.id);
      if (!loaded) continue;
      union.union(loaded.box);
      triangles += loaded.triangles;
      any = true;
    }

    let next: SceneStats | null = null;
    if (any) {
      const size = union.getSize(new THREE.Vector3());
      next = { x: size.x, y: size.y, z: size.z, triangles };
    }

    const prev = lastStatsRef.current;
    const unchanged =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.z === next.z &&
        prev.triangles === next.triangles);
    if (!unchanged) {
      lastStatsRef.current = next;
      onStats(next);
    }
  }, [parts, loadedParts, onStats]);

  return (
    // `antialias: false` -- the scene now renders offscreen into the
    // postprocessing composer's target (see `ViewerEffects` below), where
    // MSAA can't reach the default framebuffer anyway; SMAA in the composer
    // chain replaces it. `localClippingEnabled: true` is unused today but
    // required for `THREE.Material.clippingPlanes` to have any effect --
    // needed by the cross-section feature landing next on this branch, and
    // harmless to turn on now.
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ antialias: false, localClippingEnabled: true }}
      className="h-full w-full"
    >
      <color attach="background" args={[background]} />
      <Exposure exposure={lighting.exposure} />
      {/* Unconditional (not gated on `tools.grid`) -- `layers.enable` is
          idempotent, and the ortho toggle (Task 4) swaps the active camera
          out from under this, so it needs to keep re-running regardless of
          whether the grid happens to be on right now. See PlateGrid.tsx's
          file header for the full layer-trap rationale. */}
      <CameraLayers />

      <ambientLight intensity={lighting.ambient} />
      <directionalLight position={[2.5, 4, 2.5]} intensity={lighting.key} />
      <directionalLight position={[-3, 1.5, 2]} intensity={lighting.fill} />
      <directionalLight position={[0, 2, -4]} intensity={lighting.rim} />

      {/* No `preset`/`files` -- see the file header. These planes only ever
          render into a local cube render target, never fetched. */}
      <Environment resolution={256} environmentIntensity={lighting.env}>
        <Lightformer form="rect" intensity={2} position={[0, 4, 2]} scale={[6, 6, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.8} position={[-4, 1, 1]} scale={[4, 6, 1]} target={[0, 0, 0]} />
        <Lightformer form="circle" intensity={1.2} position={[3, 2, -3]} scale={[3, 3, 1]} target={[0, 0, 0]} />
        <Lightformer
          form="rect"
          intensity={0.4}
          position={[0, -3, 0]}
          scale={[8, 8, 1]}
          rotation-x={Math.PI / 2}
        />
      </Environment>

      {/* `Bounds > Resize > Center` all run their layout effects child-first,
          so this evaluates in the needed order: ground the combined bbox to
          y=0 (`Center top`), normalize its largest dimension to 1
          (`Resize`), then frame the camera to it (`Bounds`, refit driven by
          `BoundsRefitter` below). Each part gets its own `<Suspense>` +
          `PartErrorBoundary` (inside the per-part wrapper) instead of one
          shared boundary around the whole map -- see the file header for
          why. */}
      <Bounds fit clip observe margin={1.2}>
        <Resize box3={allBox ?? UNIT_BOX}>
          <Center top cacheKey={loadedCount} disable={loadedCount === 0}>
            {parts.map((part) => (
              <PartErrorBoundary key={part.id}>
                <Suspense fallback={null}>
                  <GltfPart
                    id={part.id}
                    url={part.url}
                    color={part.color}
                    visible={part.visible}
                    onLoaded={onLoaded}
                  />
                </Suspense>
              </PartErrorBoundary>
            ))}
          </Center>
        </Resize>
        <BoundsRefitter loadedCount={loadedCount} />
      </Bounds>

      {/* OUTSIDE `<Bounds>` deliberately -- `Bounds`'s `observe`/`fit` walks
          its own children's bounding box to frame the camera, and the plate
          is sized independently of the model (`plateSize`, not `allBox`);
          including it in that subtree would inflate/skew the camera fit to
          the plate instead of the model. `scaleFactor={s}` is the same
          factor `<Resize>` above computes from `allBox`, so the grid and the
          model agree on scale by construction (see `s`'s comment). Gated on
          `allBox` (not just `tools.grid`) since `s` is only meaningful once
          a part has actually loaded. */}
      {tools.grid && allBox && <PlateGrid plateSize={plateSize} scaleFactor={s} />}

      {/* A render-target soft shadow, not a shadow map -- `<Canvas>` has no
          `shadows` prop and no light here has `castShadow`. Adding either
          would double up with this and need shadow-acne tuning for no
          visual gain. `frames={1}` bakes once and goes stale, so it's keyed
          on `loadedCount` (a part finishing load) and the visible id set (a
          checkbox toggle) so the bake re-runs whenever either changes. */}
      {lighting.contactShadow && (
        <ContactShadows
          key={`${loadedCount}|${parts.filter((part) => part.visible).map((part) => part.id).join(",")}`}
          position={[0, -0.001, 0]}
          scale={3}
          far={1.2}
          blur={2.5}
          opacity={0.55}
          resolution={512}
          frames={1}
        />
      )}

      <OrbitControls makeDefault enablePan />

      <ViewerEffects ao={lighting.ao} />
    </Canvas>
  );
}

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
 * uses, plus real directional lights and `ACESFilmicToneMapping`, so PBR
 * materials (authored assuming IBL) get specular response and the model
 * reads as solid instead of flat and chalky.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Bounds,
  Center,
  Clone,
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  Resize,
  useGLTF,
} from "@react-three/drei";
import type { LightingRig } from "@/components/viewer/lighting";

// drei's `useGLTF` cache is a module-global keyed by url, so every caller of
// the same url shares the SAME `THREE.Group` scene. `<primitive>` would mount
// that shared instance directly, and because `Object3D.add` reparents, a
// second simultaneous mount of the same url (the pop-out Dialog open at the
// same time as the inline canvas, or two checked parts that dedup to one
// content-addressed blob -> one url) would detach it from the first, blanking
// it. `Clone` gives each mount its own copy of the cached scene (geometry and
// materials stay shared, so it's cheap), making concurrent mounts safe.
//
// When a per-part `color` is set (M8 G2 recolor), the shared-material path
// won't do: we have to OWN the materials to mutate them, so that branch
// deep-clones the scene AND clones each mesh material before recoloring
// (otherwise the color would bleed into every other mount of the same blob
// through the shared cache) and disposes those clones on unmount.
function GltfModel({ url, color }: { url: string; color?: string }) {
  const { scene } = useGLTF(url);
  if (!color) return <Clone object={scene} />;
  return <RecoloredModel scene={scene} color={color} />;
}

function RecoloredModel({ scene, color }: { scene: THREE.Object3D; color: string }) {
  const object = useMemo(() => {
    const cloned = scene.clone(true);
    const target = new THREE.Color(color);
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const recolor = (material: THREE.Material) => {
        const owned = material.clone(); // never mutate the shared cache material
        const std = owned as THREE.MeshStandardMaterial;
        if (std.color) std.color.copy(target);
        return owned;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(recolor)
        : recolor(mesh.material);
    });
    return cloned;
  }, [scene, color]);

  // Dispose the materials WE cloned above when this object is replaced (color
  // change) or unmounted -- R3F does not auto-dispose externally-created
  // `<primitive>` objects, so without this each recolor would leak materials.
  useEffect(() => {
    return () => {
      object.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => material.dispose());
      });
    };
  }, [object]);

  return <primitive object={object} />;
}

// `toneMappingExposure` lives on the renderer, not a scene prop, so it can't
// go through `<Canvas gl={{...}}>` -- that object is only applied once at
// construction and won't re-apply when the lighting preset changes at
// runtime. Setting it imperatively here on every `exposure` change (and
// nudging `invalidate` since the canvas is `frameloop="demand"`) is the only
// way a preset switch actually shows up.
function ToneMapping({ exposure }: { exposure: number }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = exposure;
    invalidate();
  }, [gl, exposure, invalidate]);

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
 */
export default function ModelViewer({
  parts,
  background,
  lighting,
}: {
  parts: { id: number; url: string; color?: string }[];
  background: string;
  lighting: LightingRig;
}) {
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} className="h-full w-full">
      <color attach="background" args={[background]} />
      <ToneMapping exposure={lighting.exposure} />

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
          (`Resize`), then frame the camera to it (`Bounds`). */}
      <Bounds fit clip observe margin={1.2}>
        <Resize>
          <Center top>
            {parts.map((part) => (
              <GltfModel key={part.id} url={part.url} color={part.color} />
            ))}
          </Center>
        </Resize>
      </Bounds>

      {/* A render-target soft shadow, not a shadow map -- `<Canvas>` has no
          `shadows` prop and no light here has `castShadow`. Adding either
          would double up with this and need shadow-acne tuning for no
          visual gain. Safe under `frameloop="demand"` with `frames={1}`:
          `<Canvas>` wraps all children in one `<Suspense>`, so a suspending
          `useGLTF` unmounts/remounts the whole subtree together -- the model
          is guaranteed present by the first committed frame. */}
      {lighting.contactShadow && (
        <ContactShadows
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
    </Canvas>
  );
}

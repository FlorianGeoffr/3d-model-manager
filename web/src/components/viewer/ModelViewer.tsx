/**
 * In-browser GLB viewer (Task 8). Loaded exclusively via
 * `React.lazy(() => import("@/components/viewer/ModelViewer"))` from
 * `ViewerTab` — this is the lazy-chunk boundary that keeps three.js/R3F/drei
 * out of the main bundle (Global Constraints "BUNDLE RULE"), so this module
 * (and anything it imports) must stay a `default export` and must not be
 * imported eagerly anywhere else.
 *
 * Deviation from SPEC "Frontend" viewer paragraph (controller-approved, see
 * `.superpowers/sdd/m2-constraints.md`): no drei `<Stage>`/environment
 * presets, since those fetch HDRs from a CDN at runtime and this app must
 * work fully offline/self-hosted — plain three.js lights instead.
 */
import { Canvas } from "@react-three/fiber";
import { Bounds, Clone, OrbitControls, useGLTF } from "@react-three/drei";

// drei's `useGLTF` cache is a module-global keyed by url, so every caller of
// the same url shares the SAME `THREE.Group` scene. `<primitive>` would mount
// that shared instance directly, and because `Object3D.add` reparents, a
// second simultaneous mount of the same url (the pop-out Dialog open at the
// same time as the inline canvas, or two checked parts that dedup to one
// content-addressed blob -> one url) would detach it from the first, blanking
// it. `Clone` gives each mount its own copy of the cached scene (geometry and
// materials stay shared, so it's cheap), making concurrent mounts safe.
function GltfModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <Clone object={scene} />;
}

/**
 * `parts` renders one GLB per entry inside a single shared `<Bounds>` so
 * multiple mesh parts (Workstream A "multi-part combined view") appear
 * together as one scene, each keeping its own local coordinates. Each part
 * carries a stable `id` (the source file id) used as the React key -- two
 * files can resolve to the same `url` (blobs are content-addressed by hash),
 * so keying on `url` would collide; keying on `id` keeps them distinct.
 * `background` replaces the previous hard-coded studio gray -- see
 * `background.ts` for the preset/theme resolution that produces it.
 */
export default function ModelViewer({
  parts,
  background,
}: {
  parts: { id: number; url: string }[];
  background: string;
}) {
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} className="h-full w-full">
      <color attach="background" args={[background]} />
      <ambientLight intensity={0.8} />
      <hemisphereLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.2} />
      <directionalLight position={[-10, -5, -10]} intensity={0.4} />
      <Bounds fit clip observe margin={1.2}>
        {parts.map((part) => (
          <GltfModel key={part.id} url={part.url} />
        ))}
      </Bounds>
      <OrbitControls makeDefault enablePan />
    </Canvas>
  );
}

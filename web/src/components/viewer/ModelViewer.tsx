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
import { Bounds, OrbitControls, useGLTF } from "@react-three/drei";

function GltfModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

/**
 * `urls` renders one GLB per entry inside a single shared `<Bounds>` so
 * multiple mesh parts (Workstream A "multi-part combined view") appear
 * together as one scene, each keeping its own local coordinates. Distinct
 * urls each get their own cached `useGLTF` scene (drei's loader cache is
 * keyed by url), so mounting several here is safe. `background` replaces
 * the previous hard-coded studio gray -- see `background.ts` for the
 * preset/theme resolution that produces it.
 */
export default function ModelViewer({ urls, background }: { urls: string[]; background: string }) {
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} className="h-full w-full">
      <color attach="background" args={[background]} />
      <ambientLight intensity={0.8} />
      <hemisphereLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.2} />
      <directionalLight position={[-10, -5, -10]} intensity={0.4} />
      <Bounds fit clip observe margin={1.2}>
        {urls.map((url) => (
          <GltfModel key={url} url={url} />
        ))}
      </Bounds>
      <OrbitControls makeDefault enablePan />
    </Canvas>
  );
}

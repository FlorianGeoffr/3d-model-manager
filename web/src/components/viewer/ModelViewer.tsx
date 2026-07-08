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

export default function ModelViewer({ url }: { url: string }) {
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} className="h-full w-full">
      {/* Theme-independent neutral studio background: the page background is
          near-black in dark mode, which hides dark-colored models against a
          transparent canvas. A fixed mid-light gray keeps both dark and light
          models legible (tunable). */}
      <color attach="background" args={["#a1a1aa"]} />
      <ambientLight intensity={0.8} />
      <hemisphereLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.2} />
      <directionalLight position={[-10, -5, -10]} intensity={0.4} />
      <Bounds fit clip observe margin={1.2}>
        <GltfModel url={url} />
      </Bounds>
      <OrbitControls makeDefault enablePan />
    </Canvas>
  );
}

/**
 * Imported only by ModelViewer -- bundle rule: three.js/postprocessing must
 * stay out of the main chunk.
 *
 * `EffectComposer` (R3F's, from `@react-three/postprocessing`) renders in a
 * `useFrame(..., priority=1)`, which disables R3F's own render loop and
 * takes it over -- under `frameloop="demand"` that `useFrame` still only
 * fires on invalidated frames, so no extra glue is needed to keep the
 * composer in sync with the rest of the demand-driven canvas.
 *
 * The composer renders the scene into an offscreen HalfFloat target, and
 * three.js only applies `gl.toneMapping` when rendering to the DEFAULT
 * framebuffer -- so an imperative `gl.toneMapping` assignment (as
 * `ModelViewer`'s old `ToneMapping` component used to do) would be a no-op
 * once a composer is mounted, and `EffectComposer` itself forces
 * `gl.toneMapping = NoToneMapping` on mount to prove it. Tone mapping
 * therefore has to live IN the chain, as the last effect here, rather than
 * on the renderer. Its shader reads three's `toneMappingExposure` uniform,
 * which three still uploads from `gl.toneMappingExposure` -- so the
 * per-preset exposure control (now `Exposure` in ModelViewer.tsx) keeps
 * working unchanged through that imperative path.
 *
 * `multisampling={0}` is deliberate: SMAA below replaces MSAA, so paying for
 * both would be wasted work. SMAA's edge-detection lookup textures are
 * embedded base64 data URIs in the `postprocessing` package -- no network
 * fetch, consistent with the app's offline rule (see ModelViewer.tsx's file
 * header for the fuller version of that constraint).
 *
 * N8AO is rendered conditionally on `ao` (off for the "flat" lighting
 * preset, see lighting.ts) via two composer children arrays rather than
 * `{ao && <N8AO .../>}` inline -- `EffectComposer`'s `children` prop type is
 * `JSX.Element | JSX.Element[]`, which doesn't accept the `false` a
 * short-circuited-out effect would put in the array.
 */
import { EffectComposer, N8AO, SMAA, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

export function ViewerEffects({ ao }: { ao: boolean }) {
  return (
    <EffectComposer multisampling={0}>
      {ao ? (
        <>
          <N8AO quality="medium" halfRes aoRadius={0.4} distanceFalloff={1} intensity={2} />
          <SMAA />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </>
      ) : (
        <>
          <SMAA />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </>
      )}
    </EffectComposer>
  );
}

import { SavedPanel } from "@/components/collections/SavedPanel";
import { PageContainer } from "@/components/ui/page-container";

/** Top-level home for saved-collection sync. This lived as a "Saved" tab inside
 * `/add` until users repeatedly failed to find it: nothing in the nav said
 * "collection" or "sync", so following a MakerWorld list meant clicking a button
 * labelled "Add to library" (which reads as "import one model now") and then
 * spotting a fourth tab. Following remote lists is ongoing, recurring work --
 * not a one-off add -- so it gets its own rail entry and route. The panel itself
 * is unchanged; only where it hangs in the IA moved. */
export function CollectionsPage() {
  return (
    <PageContainer width="default">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Collections</h1>
        <p className="text-sm text-muted-foreground">
          Follow saved lists from MakerWorld, Thingiverse, and Printables, and keep them synced with
          your library.
        </p>
      </div>

      <SavedPanel />
    </PageContainer>
  );
}

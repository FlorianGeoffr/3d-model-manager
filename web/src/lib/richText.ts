import DOMPurify from "dompurify";

// Imported descriptions can carry links back to the source listing --
// always open them in a new tab, with `rel` locked down against tabnabbing.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const HAS_TAG = /<[a-z][^>]*>/i;

/** Imported descriptions (MakerWorld/Printables/Thingiverse) are HTML
 * fragments (`<p><strong>…`, `&amp;`); user-edited ones are plain text with
 * no markup at all. Sanitizes to a safe HTML fragment for read-mode
 * rendering -- DOMPurify's default allowlist plus `target`/`rel` so links
 * can safely open in a new tab. Plain-text input (no tags) has its line
 * breaks turned into `<br>` first, since a bare newline collapses in HTML. */
export function sanitizeDescriptionHtml(raw: string): string {
  const html = HAS_TAG.test(raw) ? raw : raw.replace(/\n/g, "<br>");
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}

/** Strips markup down to plain text, collapsing whitespace -- for contexts
 * (card summaries, previews) that want a plain string rather than rendered
 * HTML. */
export function toPlainText(raw: string): string {
  // DOMPurify with an empty tag allowlist strips markup but re-escapes
  // entities in its string output (`&amp;` stays `&amp;`) -- parsing the
  // sanitized fragment and reading `textContent` decodes them.
  const stripped = DOMPurify.sanitize(raw, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  const div = document.createElement("div");
  div.innerHTML = stripped;
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

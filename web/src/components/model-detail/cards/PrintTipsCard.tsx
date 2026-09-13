/** Right-column placeholder (R13a) -- print tips (freeform per-model notes
 * on how to best print the thing) don't have a data model yet; that lands in
 * a future revision's `models.print_tips` column + `MetadataEditor`. Renders
 * nothing for now (per the "no dead controls" rule -- a disabled textarea is
 * still a control) rather than a permanently-disabled field; `ModelDetailPage`
 * has stopped rendering this card too, but the component stays so wiring it
 * back in is a one-line change once the data model lands.
 *
 * TODO(R13c): replace with a real `models.print_tips` editor and re-add to
 * `ModelDetailPage`'s right column. */
export function PrintTipsCard() {
  return null;
}

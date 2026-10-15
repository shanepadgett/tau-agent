/**
 * The two texts on the preview's top border: the story and state on the left, the size on the
 * right. When both do not fit, the size loses its "clipped" note first, then the name is cut.
 */

/** The two corners, a dash beside each text, and one dash between the texts. */
const BORDER_COLUMNS = 5;

export type PreviewInsets = { readonly name: string; readonly size: string };

export const previewInsets = (
  borderColumns: number,
  name: string,
  fullSize: string,
  shortSize: string,
): PreviewInsets => {
  const fits = (size: string) => name.length + size.length + BORDER_COLUMNS <= borderColumns;
  const size = fits(fullSize) ? fullSize : shortSize;
  const room = borderColumns - BORDER_COLUMNS - size.length;

  if (name.length <= room) return { name, size };
  return { name: room > 0 ? `${name.slice(0, room - 1)}…` : "", size };
};

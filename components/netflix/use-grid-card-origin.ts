import { useEffect, type RefObject } from "react";

/**
 * Netflix-style cards scale up on hover. In a multi-column grid that has no
 * horizontal overflow clipping, cards in the first and last columns would grow
 * outward past the viewport edges. This sets a `--card-origin` custom property
 * on each grid child so those edge cards scale *inward* instead:
 *   first column → "left center", last column → "right center", else "center".
 *
 * The property inherits down to the card's scaling layer (which reads it via
 * `transform-origin: var(--card-origin, center)`). Column count is read from the
 * live computed grid template, so it stays correct across responsive breakpoints;
 * a ResizeObserver recomputes on width changes, and `deps` handles item changes.
 */
export function useGridCardOrigin(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[]
): void {
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;

    const apply = () => {
      const template = getComputedStyle(grid).gridTemplateColumns;
      const cols = template && template !== "none" ? template.split(" ").length : 1;
      const children = Array.from(grid.children) as HTMLElement[];
      children.forEach((child, i) => {
        const col = i % cols;
        const origin =
          cols === 1
            ? "center"
            : col === 0
              ? "left center"
              : col === cols - 1
                ? "right center"
                : "center";
        child.style.setProperty("--card-origin", origin);
      });
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(grid);
    return () => observer.disconnect();
    // deps is caller-provided (item count etc.); intentionally spread as-is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

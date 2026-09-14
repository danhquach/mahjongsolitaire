/** Look up an element by id, or fail loudly at boot: a missing element is a
 *  markup/script mismatch, never something to limp past. */
export function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  // getElementById types as HTMLElement even for an inline <svg>; widen
  // through Element so an SVG root can be asked for without a double cast.
  return node as Element as T;
}

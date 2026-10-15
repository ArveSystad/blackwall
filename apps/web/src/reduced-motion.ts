/** Whether the OS asks for reduced motion; false where `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

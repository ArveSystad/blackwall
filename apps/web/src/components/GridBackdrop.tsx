/**
 * Decorative resting background of the empty main pane (first-run setup steps
 * or "No task selected"; never behind a task view, Settings or modals): a perspective floor that
 * drifts toward the viewer, a horizon glow and a slow scanline (dark only).
 * Also the full-page Stats screen's background.
 * Pure CSS (see `.bw-grid*` in styles.css); nothing runs per frame in JS.
 * The parent must be `relative` and must not scroll: put scrolling content in
 * a sibling, so the backdrop stays fixed. Keep content within the ~520px
 * column the mask fades (`calc(50% ± 260px)`), or lines show under it.
 */
export function GridBackdrop() {
  return (
    <div className="bw-grid" aria-hidden="true">
      <div className="bw-grid-sky" />
      <div className="bw-grid-glow" />
      <div className="bw-grid-floor">
        <div className="bw-grid-plane" />
      </div>
      <div className="bw-grid-horizon" />
      <div className="bw-grid-scan" />
    </div>
  );
}

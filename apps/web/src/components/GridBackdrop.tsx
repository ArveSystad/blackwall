/**
 * Decorative grid behind the first-run setup steps: a perspective floor that
 * drifts toward the viewer, a horizon glow and a slow scanline (dark only).
 * Pure CSS (see `.bw-grid*` in styles.css); nothing runs per frame in JS.
 * The parent must be `relative`.
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

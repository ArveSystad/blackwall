/** How long a home pill's assigned boom plays; mirrors `.bw-assigned` / `.bw-assigned-flash` in styles.css. */
export const ASSIGNED_BOOM_MS = 2400;

/** Whether a pill's count change is new work arriving: a rise from exactly zero. Unknown counts never boom. */
export function boomsOnRise(prev: number | null, next: number | null): boolean {
  return prev === 0 && next !== null && next > 0;
}

/** Flavour lines the chat's busy line rotates through while a turn runs. */
export const CHAT_FLAVOUR_PHRASES: readonly string[] = [
  "Reticulating splines…",
  "Jacking in…",
  "Rerouting power to the core…",
  "Spinning up the mainframe…",
  "Decrypting the payload…",
  "Bypassing the firewall…",
  "Scanning the sector…",
  "Charging the plasma coils…",
  "Consulting the oracle…",
  "Compiling shaders…",
  "Loading the next level…",
  "Calibrating the flux capacitor…",
  "Defragmenting memories…",
  "Polling the hive mind…",
  "Tracing the signal…",
  "Rolling for initiative…",
  "Hacking the Gibson…",
  "Grinding for XP…",
  "Overclocking neurons…",
];

/** Shortest gap between two flavour phrases. */
export const CHAT_FLAVOUR_MIN_MS = 2_500;

/** Longest gap between two flavour phrases. */
export const CHAT_FLAVOUR_MAX_MS = 4_000;

/**
 * A random flavour phrase. When `previous` is one of the phrases, picks among
 * the others, so the line never repeats itself; otherwise picks from them all.
 */
export function nextPhrase(previous: string | null, random: () => number = Math.random): string {
  const n = CHAT_FLAVOUR_PHRASES.length;
  const prevIndex = previous === null ? -1 : CHAT_FLAVOUR_PHRASES.indexOf(previous);
  if (prevIndex === -1) return CHAT_FLAVOUR_PHRASES[Math.floor(random() * n)]!;
  let i = Math.floor(random() * (n - 1));
  if (i >= prevIndex) i++;
  return CHAT_FLAVOUR_PHRASES[i]!;
}

/** A fresh random gap before the next flavour phrase, between the min and max. */
export function flavourDelayMs(random: () => number = Math.random): number {
  return CHAT_FLAVOUR_MIN_MS + random() * (CHAT_FLAVOUR_MAX_MS - CHAT_FLAVOUR_MIN_MS);
}

/** The options whose `text` contains `query`, ignoring case; all of them for a blank query. */
export function filterOptions<T>(
  options: readonly T[],
  query: string,
  text: (option: T) => string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => text(option).toLowerCase().includes(needle));
}

/** What a closed multi-pick shows: null for none, "a, b" for up to two, "a +2" for more. */
export function selectionSummary(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length <= 2) return labels.join(", ");
  return `${labels[0]} +${labels.length - 1}`;
}

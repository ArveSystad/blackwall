export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const num = (value: unknown): number => (typeof value === "number" ? value : 0);

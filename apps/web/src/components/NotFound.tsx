import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="font-medium text-foreground-strong">Page not found</span>
      <Link to="/">Back to the inbox</Link>
    </div>
  );
}

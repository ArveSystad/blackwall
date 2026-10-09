import { Link } from "@tanstack/react-router";
import { EmptyState } from "./EmptyState";

export function NotFound() {
  return (
    <EmptyState className="h-full" title="Page not found">
      <Link to="/">Back to the inbox</Link>
    </EmptyState>
  );
}

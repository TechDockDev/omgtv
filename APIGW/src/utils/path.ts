export function normalizeSegment(segment: string): string {
  return segment.replace(/(^\/+|\/+$)/g, "");
}

export function joinUrlSegments(
  ...segments: readonly (string | undefined)[]
): string {
  return segments
    .filter(
      (segment): segment is string =>
        typeof segment === "string" && segment.length > 0
    )
    .map((segment) => normalizeSegment(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function ensureLeadingSlash(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path;
}

/**
 * Centralized utility for mapping internal Storage URLs to public CDN URLs.
 */
export function ensureCdnUrl(url?: string | null): string | null {
  if (!url) return null;

  // Only transform GCS URLs
  if (!url.startsWith("https://storage.googleapis.com")) {
    return url;
  }

  // Only transform in production mode
  if (process.env.NODE_ENV !== "production") {
    return url;
  }

  // Normalize any old bucket names to the current bucket first
  const normalized = url
    .replace(/https:\/\/storage\.googleapis\.com\/videos-bucket-pocketlol-prod\//g,
      "https://storage.googleapis.com/videos-bucket-omgtv-prod/")
    .replace(/https:\/\/storage\.googleapis\.com\/videos-bucket-pocketlol\//g,
      "https://storage.googleapis.com/videos-bucket-omgtv-prod/");

  // Replace GCS storage domain with our production CDN domain
  return normalized.replace(
    /https:\/\/storage\.googleapis\.com\/videos-bucket-omgtv-prod/g,
    "https://media.omgtv.in"
  );
}

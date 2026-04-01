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

  // Replace GCS storage domain with our production CDN domain
  // Supports both production and development bucket variants
  return url.replace(
    /https:\/\/storage\.googleapis\.com\/videos-bucket-pocketlol(-prod|-dev)?/g,
    "https://media.omgtv.in"
  );
}

export function createHttpError(
  statusCode: number,
  message: string,
  cause?: unknown
): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = statusCode;
  if (cause) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

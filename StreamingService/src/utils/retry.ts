export interface RetryOptions {
  retries: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

const defaultMinDelay = 200;
const defaultMaxDelay = 5_000;

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const minDelay = options.minDelayMs ?? defaultMinDelay;
  const maxDelay = options.maxDelayMs ?? defaultMaxDelay;

  let attempt = 0;
  // Attempt counter is zero indexed to make logging easier.
  while (attempt <= options.retries) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === options.retries) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      options.onRetry?.(error, nextAttempt);
      const delay = Math.min(maxDelay, minDelay * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt = nextAttempt;
    }
  }
  throw new Error("Exhausted retries without executing operation");
}

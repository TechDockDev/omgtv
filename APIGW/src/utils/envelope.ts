export type ErrorStatusCode = number;

export interface SuccessResponse<T = unknown> {
  success: true;
  statusCode: 0;
  userMessage: string;
  developerMessage: string;
  data: T;
}

export interface ErrorResponse {
  success: false;
  statusCode: ErrorStatusCode;
  userMessage: string;
  developerMessage: string;
  data: Record<string, never>;
}

type NormalizedSuccessData<T> = T extends undefined ? Record<string, never> : T;

const DEFAULT_SUCCESS_MESSAGE = "Success";

export function wrapSuccess<T>(
  data: T,
  userMessage?: string,
  developerMessage?: string
): SuccessResponse<NormalizedSuccessData<T>> {
  const normalizedData = (
    data === undefined ? ({} as Record<string, never>) : data
  ) as NormalizedSuccessData<T>;
  const resolvedUserMessage = userMessage ?? DEFAULT_SUCCESS_MESSAGE;
  const resolvedDeveloperMessage = developerMessage ?? resolvedUserMessage;

  return {
    success: true,
    statusCode: 0,
    userMessage: resolvedUserMessage,
    developerMessage: resolvedDeveloperMessage,
    data: normalizedData,
  };
}

export function wrapError(
  statusCode: ErrorStatusCode,
  userMessage: string,
  developerMessage?: string
): ErrorResponse {
  const normalizedStatus =
    typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
      ? statusCode
      : 500;

  return {
    success: false,
    statusCode: normalizedStatus,
    userMessage,
    developerMessage: developerMessage ?? userMessage,
    data: {},
  };
}

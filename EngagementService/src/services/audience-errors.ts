export type AudienceErrorCode =
  | "VALIDATION_FAILED"
  | "GROUP_TOO_SMALL"
  | "GROUP_TOO_LARGE"
  | "PHOTO_OR_PDF_REQUIRED"
  | "DUPLICATE_MOBILE"
  | "ALREADY_REGISTERED"
  | "REGISTRATION_CLOSED"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const HTTP_STATUS: Record<AudienceErrorCode, number> = {
  VALIDATION_FAILED: 422,
  GROUP_TOO_SMALL: 422,
  GROUP_TOO_LARGE: 422,
  PHOTO_OR_PDF_REQUIRED: 422,
  DUPLICATE_MOBILE: 409,
  ALREADY_REGISTERED: 409,
  REGISTRATION_CLOSED: 403,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AudienceError extends Error {
  readonly httpStatus: number;

  constructor(
    public readonly code: AudienceErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly referenceId?: string
  ) {
    super(message);
    this.name = "AudienceError";
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface AudienceErrorBody {
  error: {
    code: AudienceErrorCode;
    message: string;
    fields?: Record<string, string>;
    reference_id?: string;
  };
}

export function toErrorBody(err: AudienceError): AudienceErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.referenceId ? { reference_id: err.referenceId } : {}),
    },
  };
}

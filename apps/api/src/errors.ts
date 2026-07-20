/**
 * Typed API error carrying an HTTP status code, plus an optional STABLE
 * machine-readable `code` (e.g. `unrecognized_channel`, `origin_token_invalid`)
 * for clients that must branch on the rejection class without parsing prose.
 * Routes catch these and convert them to JSON responses (`{ error, code? }`).
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Produce a 404 Not Found error. */
export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

/** Produce a 400 Bad Request error. */
export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

/** Produce a 422 Unprocessable Content error (well-formed but disallowed). */
export function unprocessable(message: string, code?: string): ApiError {
  return new ApiError(422, message, code);
}

/** Produce a 500 Internal Server Error. */
export function internalError(message: string): ApiError {
  return new ApiError(500, message);
}

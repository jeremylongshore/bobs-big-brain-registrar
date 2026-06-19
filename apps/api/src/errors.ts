/**
 * Typed API error carrying an HTTP status code.
 * Routes catch these and convert them to JSON responses.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
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
export function unprocessable(message: string): ApiError {
  return new ApiError(422, message);
}

/** Produce a 500 Internal Server Error. */
export function internalError(message: string): ApiError {
  return new ApiError(500, message);
}

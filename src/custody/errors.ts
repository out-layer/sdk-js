/** A refusal of the API or of this client's own checks. */
export class CustodyError extends Error {
  constructor(
    message: string,
    /** The API's error code, when the API refused. */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CustodyError';
  }
}

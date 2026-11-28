/** A refusal of the API or of this client's own checks. */
export class CustodyError extends Error {
  /**
   * On `operation_waiting` (409): the `id` of the wallet's operation that is
   * prepared and not over. Relay it or read it by this id, or ask again once
   * its ten minutes have ended. `undefined` on every other refusal.
   */
  readonly waitingOperationId?: string;

  constructor(
    message: string,
    /** The API's error code, when the API refused. */
    readonly code?: string,
    readonly status?: number,
    details?: { waitingOperationId?: string },
  ) {
    super(message);
    this.name = 'CustodyError';
    if (details?.waitingOperationId !== undefined)
      this.waitingOperationId = details.waitingOperationId;
  }
}

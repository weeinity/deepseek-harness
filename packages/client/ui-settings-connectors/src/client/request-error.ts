/** Remote refusal codes used to select localized recovery instructions. */

/** A public Remote error code without potentially private configuration details. */
export class ConnectorRequestError extends Error {
  /** @param code - Public Remote refusal code. */
  constructor(readonly code: string) {
    super(code)
    this.name = 'ConnectorRequestError'
  }
}

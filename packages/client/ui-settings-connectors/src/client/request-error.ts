/** Remote refusals without private configuration details. */

/** A public Remote error code without potentially private configuration details. */
export class ConnectorRequestError extends Error {
  /** @param code - Public Remote refusal code. */
  constructor(readonly code: string) {
    super(code)
    this.name = 'ConnectorRequestError'
  }
}

import { BaseError, ContractFunctionRevertedError } from 'viem'

/** An error the API turns into an HTTP status with a message the client can show. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message)
  }
}

/** A revert raised without viem (tests' fake gateway). */
export class ChainRevert extends Error {}

/** True when the chain rejected the call (a revert), as opposed to an RPC or network problem worth retrying. */
export function isRevert(e: unknown): boolean {
  if (e instanceof ChainRevert) return true
  return e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError)
}

/** A short message; for a revert, the decoded error (or its raw selector) so ops can tell why. */
export function errorMessage(e: unknown): string {
  if (!(e instanceof BaseError)) return e instanceof Error ? e.message : String(e)
  const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
  if (!revert) return e.shortMessage
  if (revert.data) return `${revert.data.errorName}(${(revert.data.args ?? []).map(String).join(', ')})`
  return revert.reason ?? (revert.signature ? `unknown error ${revert.signature}` : `${e.shortMessage} (no revert data)`)
}

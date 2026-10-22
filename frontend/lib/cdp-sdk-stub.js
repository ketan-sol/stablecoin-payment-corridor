// Browser stand-in for @coinbase/cdp-sdk. @base-org/account imports it only for server-side subscription charging,
// which Corridor never uses; bundling the real SDK would drag in its server-only x402 dependencies.
export class CdpClient {
  constructor() {
    throw new Error('@coinbase/cdp-sdk is not available in the browser bundle')
  }
}

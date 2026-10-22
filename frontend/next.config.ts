import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@corridor/shared'],
  // The wallet connectors reach @coinbase/cdp-sdk (server-side subscriptions, never used here); stub it out.
  turbopack: { resolveAlias: { '@coinbase/cdp-sdk': './lib/cdp-sdk-stub.js' } },
}

export default config

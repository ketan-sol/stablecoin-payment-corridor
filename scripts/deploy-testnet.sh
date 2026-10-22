#!/usr/bin/env bash
# Deploys Corridor to Arc testnet (settlement) and Base Sepolia (source), in Deploy.s.sol's order, then writes
# backend/.env and frontend/.env.local. Safe to rerun: finished steps are skipped.
# Needs: contracts/.env from `node scripts/testnet.mjs keys`, and a funded deployer (see README "Testnet").
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

set -a
source contracts/.env
set +a

node scripts/testnet.mjs status
node scripts/testnet.mjs fund

deploy() { # <sig> <rpc>
  (cd contracts && forge script script/Deploy.s.sol --sig "$1" --rpc-url "$2" --private-key "$DEPLOYER_KEY" --broadcast --slow)
}

if [ ! -f contracts/deployments/settlement-5042002.json ]; then
  echo "== 1. settlement contracts on Arc testnet"
  deploy "settlement()" "$ARC_RPC_URL"
fi
node scripts/testnet.mjs sync
set -a; source contracts/.env; set +a # ESCROW for the router

if [ ! -f contracts/deployments/source-84532.json ]; then
  echo "== 2. router and fee vault on Base Sepolia"
  deploy "source()" "$BASE_SEPOLIA_RPC_URL"
fi
node scripts/testnet.mjs sync
set -a; source contracts/.env; set +a

echo "== 3. escrow trusts the Base Sepolia router"
deploy "trustRouter()" "$ARC_RPC_URL"

node scripts/testnet.mjs status
echo "Done. Start the backend (npm start -w backend) and the frontend (npm run dev:frontend)."

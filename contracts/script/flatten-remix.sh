#!/bin/sh
# One self-contained file per deployable for Remix (no imports to resolve). Run from contracts/:
#   sh script/flatten-remix.sh
set -e
mkdir -p remix
for c in SanctionsOracle ComplianceRegistry PaymentEscrow FeeVault PaymentRouter; do
  forge flatten "src/$c.sol" -o "remix/$c.sol" > /dev/null
  echo "remix/$c.sol"
done

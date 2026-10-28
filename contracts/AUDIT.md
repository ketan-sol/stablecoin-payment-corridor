# Corridor contracts: security review (phase 1)

Scope: the EVM contracts in [`src/`](src) plus the testnet sanctions oracle, as of 2026-10-22:
`PaymentRouter`, `PaymentEscrow` (UUPS), `ComplianceRegistry` (UUPS), `FeeVault`, `SanctionsOracle`.
The TRON leg (`TronPaymentRouter`) was removed on 2026-10-22 to focus on EVM; its findings are dropped below.

Method:
- manual review;
- 58 Foundry tests, including fuzz tests, 4 invariants over 8,192 random calls per run, and a TypeScript ↔ Solidity
  EIP-712 digest check;
- 2 fork tests against the real Circle CCTP V2, Permit2 and USDC on Base Sepolia and Arc testnet (both pass);
- Slither 0.11.6 and Aderyn 0.6.8.

Raw tool output: [`audit/slither.md`](audit/slither.md), [`audit/aderyn.md`](audit/aderyn.md).

This is a self-review, not an independent audit.

## Design in one paragraph

The sender signs one Permit2 witness, for a single payment or a net-settlement batch of up to 50. A relayer
submits it to the stateless `PaymentRouter`. The router sends the fee to `FeeVault` and burns the rest with CCTP V2
`depositForBurnWithHook`, with the escrow as both mint recipient and destination caller and the payments in the
hook data. On Arc, the relayer calls `PaymentEscrow.receivePayment`. The escrow delivers the message itself,
measures what was minted, and records each payment under `keccak256(sourceDomain, paymentId)`, but only when the
burn came from a trusted router. A second intake, `fundFromLiquidity`, lets a liquidity provider fund a payment in
a whitelisted stablecoin (token-agnostic escrow); the backend does not use it yet. A release needs `ComplianceRegistry.isAllowed`
(unexpired KYB attestations, sanctions-oracle clear). One officer can freeze; unfreeze and refund need two different
officers. Refunds are credited and pulled. Every money-moving function is reentrancy-guarded, and every contract
has a pause switch except the registry, which holds no funds.

## Findings

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| R-01 | Medium | Liquidity provider decides the parties of a payment it funds | Accepted; reconciliation required before use |
| R-02 | Medium | Intake depends on the RELAYER role | Accepted (plan requires the role) |
| R-03 | Low | A batch never lands as payments if CCTP ever charges a fee | Accepted |
| R-04 | Low | Router accepts any token Permit2 can move | Accepted |
| R-05 | Low | Signed fee is kept on refund | By design; disclose in terms |
| R-06 | Low | Admin controls unattributed funds | Accepted |
| R-07 | Low | Two-approver rule is only as good as key separation | Operational |
| R-08 | Info | A trusted-router message that fails to decode would be stuck | Accepted |
| R-09 | Info | (removed: TRON leg dropped) | — |
| R-10 | Info | Native value sent with `upgradeToAndCall` | Accepted |
| R-11 | Info | `maxFee = 0` on every burn | Monitor |

### R-01 Medium: liquidity provider decides the parties of a payment it funds

`fundFromLiquidity` takes sender, receiver and refund address from the `MARKET_MAKER` caller; nothing on-chain ties
them to the off-CCTP funding leg it represents. The money is the provider's own, and `release` still requires
`isAllowed(sender, receiver)` and pays only the recorded receiver or an approved off-ramp, so a compromised provider
key can only misdirect the provider's own funds to an onboarded party.

Before this intake is used: reconcile every `Received` event in `LIQUIDITY_DOMAIN` against the funding leg's record,
and keep `MARKET_MAKER` and `PAYOUT_OPERATOR` on different keys. No role holds `MARKET_MAKER` in the current deployment
scripts' backend wiring except the local demo account.

### R-02 Medium: intake depends on the RELAYER role

The plan has the relayer submit intents and `receiveMessage` calls, so `pay`, `payBatch` and `receivePayment` are
RELAYER-only. If the relayer is down, payments wait (quotes expire, attested messages stay deliverable). If it's
compromised, it can't redirect funds: every field is signed or comes from the router's burn. Recovery is the admin
granting the role to a new key.

### R-03 Low: a batch never lands as payments if CCTP ever charges a fee

A single payment records whatever arrived. A batch must account for exactly what arrived, or it lands as
unattributed funds and ops has to sweep and repay it. Today's standard transfers charge nothing (`maxFee = 0`,
`minFee` 0 or absent on every chain checked). Tests: `test_receive_singlePaymentAbsorbsCctpFee`,
`test_receive_batchWithCctpFeeStaysUnattributed`.

### R-04 Low: router accepts any token Permit2 can move

The router is stateless, so it keeps no token list. A non-USDC token reverts inside CCTP (`depositForBurn`
supports only registered burn tokens), so nothing reaches the escrow. A fee in a junk token can sit in `FeeVault`;
only the treasury can move it.

### R-05 Low: signed fee is kept on refund

Fees go to `FeeVault` at pay time; refunds return the net (`test_refundPaths_exactlyOnce`). State this in the terms,
or take the fee at release instead.

### R-06 Low: admin controls unattributed funds

Burns from untrusted senders, mismatched batches, reused IDs and donations stay outside `totalHeld`, and
`sweepUnattributed` lets the admin move them. Without that, they'd be locked, because only the escrow can deliver
its messages. The admin can never touch funds owed to payments or refunds (the invariant suite includes sweeps).
Every `Unattributed` event should open an ops case.

### R-07 Low: two-approver rule is only as good as key separation

`unfreeze` and `refund` need two different `COMPLIANCE_OFFICER` addresses. A different action from the second
officer replaces the proposal instead of executing it, and a freeze clears it. If one person holds both keys, it
is one approver. Hold the role in two Safes or two people's hardware keys. Tests:
`test_freeze_thenUnfreezeNeedsTwoOfficers`, `test_refundNeedsTwoOfficersAndAgreement`,
`test_freezeClearsAPendingProposal`; the invariant handler also checks that a single officer never completes a
refund.

### R-08 Info: a trusted-router message that fails to decode would be stuck

The escrow is the destination caller, so if `receivePayment` reverted after a trusted router's burn, the message
could never be delivered. The router always encodes `(sender, refundTo, Leg[])`. Every other post-delivery case
(untrusted sender, mismatch, reused or duplicate keys) lands as unattributed instead of reverting. Keep an old
escrow live, and a rotated-out router trusted, until their in-flight messages land.

### R-10 Info: native value sent with `upgradeToAndCall`

OpenZeppelin's UUPS `upgradeToAndCall` is payable (Aderyn H-1). Only the admin can call it. On Arc the native
currency *is* USDC and shares the ERC-20 balance, so value sent to the escrow becomes unattributed USDC that can be
swept. On the registry it would be stuck; don't send value.

### R-11 Info: `maxFee = 0` on every burn

If Circle enables a minimum fee on a source chain, `pay` reverts (an outage, not a loss). Alert on `minFee() != 0`.

## Earlier findings resolved by this design

| Earlier ID | Was | Now |
| --- | --- | --- |
| C-01 | Router owner could redirect signed payments by changing the escrow | The router has no owner setting for this: escrow and destination domain are immutable |
| C-02 | Relayer chose sender and receiver at `credit` | Parties come from the router's hook data, only from a trusted router |
| C-03 | Refunds went to the sender's address on Arc | Signed `refundTo` |
| C-05 | Payment IDs collided across source chains | Keyed by `(sourceDomain, paymentId)` |
| C-06 | Timeout refunds ignored pause | `whenNotPaused` |
| C-07 | Credited amount assumed no CCTP fee | Single payments record what arrived (R-03 covers batches) |
| C-08 | USDC blocklist could strand a refund | Pull-based refunds: the state change never depends on the transfer |
| C-09 | Floating pragma | Deployables pinned to `0.8.28` |
| C-10 | Single-key compliance | Two-approver unfreeze and refund (R-07) |
| C-13 | Balance-delta intake could double-count on reentry | `nonReentrant`; `test_receive_nestedDeliveryReverts` |

## Tool findings triage

| Tool | Finding | Verdict |
| --- | --- | --- |
| Slither | `reentrancy-balance` in `PaymentRouter._pull` | Accepted: Permit2 is trusted; a token callback can't re-enter `pay` or `payBatch` (RELAYER-only). |
| Slither | `reentrancy-balance` / `reentrancy-benign` in `PaymentEscrow.receivePayment` | Guarded: `nonReentrant`; the state written after the call depends on the measured delta by design. |
| Slither | `incorrect-equality` `sum == received`, `received == 0` | Intended: exact accounting and "minted elsewhere". |
| Slither | `uninitialized-local` `sum` | Initialized explicitly. |
| Slither | `reentrancy-events` | Accepted: events follow trusted calls; no state depends on their order. |
| Slither | `timestamp` (KYB expiry, refund window) | Accepted: windows are hours to days. |
| Slither | `missing-inheritance` (registry ↔ `ISanctionsList`) | False positive: the registry consumes the oracle; it isn't one. |
| Slither | `unused-state` (message-offset constants) | False positive: used as calldata slice bounds. |
| Aderyn | H-1 locks Ether | R-10. |
| Aderyn | H-2 state change after external call | `fundFromLiquidity` and `receivePayment` are `nonReentrant`; tokens are allowlisted or USDC. |
| Aderyn | L-1 centralization | R-06, R-07; admin belongs behind a timelock with a PQAccount or Safe proposer (`Deploy.s.sol` `timelock()`, `handover()`). |
| Aderyn | L-2 costly loop, L-5 revert in loop | Batches are capped at 50 legs; validation is all-or-nothing by design. |
| Aderyn | L-3 empty block | `_authorizeUpgrade`: the role modifier is the check. |
| Aderyn | L-4 PUSH0, L-8 floating pragma | Interfaces only (`^0.8.24`); every target chain is post-Shanghai. |
| Aderyn | L-6 unchecked `_grantRole`, L-7 uninitialized locals | False positives. |

## Facts checked before testnet deploy (2026-10-19)

| Item | Value | Source |
| --- | --- | --- |
| `depositForBurnWithHook` | `(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData)`; hook data must be non-empty and is never executed by CCTP | Circle `TokenMessengerV2.sol`; fork test |
| Burn body layout | version 0, burnToken 4, mintRecipient 36, amount 68, messageSender 100, maxFee 132, feeExecuted 164, expirationBlock 196, hookData 228 | Circle `BurnMessageV2.sol`; fork test |
| `receiveMessage` | enforces `destinationCaller == msg.sender` when set, the destination domain, an unused nonce | Circle `MessageTransmitterV2.sol`; fork test |
| TokenMessengerV2 / MessageTransmitterV2 (testnets) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` / `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | Circle docs |
| CCTP domains | Ethereum 0, Base 6, Arc 26 | Circle docs |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` on Sepolia, Base Sepolia, Arc | `eth_getCode` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` on Sepolia, Base Sepolia, Arc | `eth_getCode` |
| USDC | Sepolia `0x1c7D…7238`, Base Sepolia `0x036C…CF7e`, Arc `0x3600…0000` (ERC-20, 6 decimals) | Circle docs, `decimals()` |
| Arc testnet | chain ID 5042002, RPC `https://rpc.testnet.arc.io`, USDC gas (native 18 decimals), Osaka EVM | Arc docs, `eth_chainId` |

**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [arbitrary-send-erc20](#arbitrary-send-erc20) (1 results) (High)
 - [reentrancy-balance](#reentrancy-balance) (2 results) (High)
 - [incorrect-equality](#incorrect-equality) (2 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (1 results) (Medium)
 - [reentrancy-benign](#reentrancy-benign) (1 results) (Low)
 - [reentrancy-events](#reentrancy-events) (3 results) (Low)
 - [timestamp](#timestamp) (5 results) (Low)
 - [missing-inheritance](#missing-inheritance) (1 results) (Informational)
 - [unused-state](#unused-state) (2 results) (Informational)
## arbitrary-send-erc20
Impact: High
Confidence: High
 - [ ] ID-0
[TronPaymentRouter.pay(TronPaymentRouter.TronIntent,bytes)](../src/TronPaymentRouter.sol#L80-L101) uses arbitrary from in transferFrom: [usdt.safeTransferFrom(intent.sender,address(this),intent.amount)](../src/TronPaymentRouter.sol#L92)

../src/TronPaymentRouter.sol#L80-L101


## reentrancy-balance
Impact: High
Confidence: Medium
 - [ ] ID-1
Reentrancy in [PaymentRouter._pull(ISignatureTransfer.PermitTransferFrom,address,bytes32,string,bytes)](../src/PaymentRouter.sol#L196-L215):
	External call allowing reentrancy:
	- [permit2.permitWitnessTransferFrom(permit,ISignatureTransfer.SignatureTransferDetails({to:address(this),requestedAmount:permit.permitted.amount}),sender,witness,witnessType,signature)](../src/PaymentRouter.sol#L206-L213)
	Balance read before the call:
	- [before = token.balanceOf(address(this))](../src/PaymentRouter.sol#L205)
	Possible stale balance used after the call in a condition:
	- [token.balanceOf(address(this)) - before != permit.permitted.amount](../src/PaymentRouter.sol#L214)
		- stale variable `before`

../src/PaymentRouter.sol#L196-L215


 - [ ] ID-2
Reentrancy in [PaymentEscrow._deliver(bytes,bytes)](../src/PaymentEscrow.sol#L351-L357):
	External call allowing reentrancy:
	- [! transmitter.receiveMessage(message,attestation)](../src/PaymentEscrow.sol#L354)
	Balance read before the call:
	- [before = usdc.balanceOf(address(this))](../src/PaymentEscrow.sol#L352)
	Possible stale balance used after the call in a condition:
	- [received == 0](../src/PaymentEscrow.sol#L356)
		- stale variable `received`

../src/PaymentEscrow.sol#L351-L357


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-3
[PaymentEscrow._recordable(uint32,PaymentEscrow.Leg[],uint256)](../src/PaymentEscrow.sol#L361-L374) uses a dangerous strict equality:
	- [sum == received](../src/PaymentEscrow.sol#L373)

../src/PaymentEscrow.sol#L361-L374


 - [ ] ID-4
[PaymentEscrow._deliver(bytes,bytes)](../src/PaymentEscrow.sol#L351-L357) uses a dangerous strict equality:
	- [received == 0](../src/PaymentEscrow.sol#L356)

../src/PaymentEscrow.sol#L351-L357


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-5
[PaymentEscrow._recordable(uint32,PaymentEscrow.Leg[],uint256).sum](../src/PaymentEscrow.sol#L364) is a local variable never initialized

../src/PaymentEscrow.sol#L364


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-6
Reentrancy in [PaymentEscrow.receivePayment(bytes,bytes)](../src/PaymentEscrow.sol#L194-L220):
	External calls:
	- [received = _deliver(message,attestation)](../src/PaymentEscrow.sol#L204)
		- [! transmitter.receiveMessage(message,attestation)](../src/PaymentEscrow.sol#L354)
	State variables written after the call(s):
	- [_record(sourceDomain,address(usdc),sender,refundTo,legs[i])](../src/PaymentEscrow.sol#L213)
		- [payments[key] = Payment(token,sender,leg.receiver,refundTo,SafeCast.toUint128(leg.amount),uint64(block.timestamp),Status.Escrowed)](../src/PaymentEscrow.sol#L379-L381)
	- [_record(sourceDomain,address(usdc),sender,refundTo,legs[i])](../src/PaymentEscrow.sol#L213)
		- [totalHeld[token] += leg.amount](../src/PaymentEscrow.sol#L378)

../src/PaymentEscrow.sol#L194-L220


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-7
Reentrancy in [PaymentRouter.pay(PaymentRouter.PaymentIntent,ISignatureTransfer.PermitTransferFrom,address,bytes)](../src/PaymentRouter.sol#L114-L130):
	External calls:
	- [_pull(permit,sender,hashIntent(intent),INTENT_WITNESS,signature)](../src/PaymentRouter.sol#L124)
		- [permit2.permitWitnessTransferFrom(permit,ISignatureTransfer.SignatureTransferDetails({to:address(this),requestedAmount:permit.permitted.amount}),sender,witness,witnessType,signature)](../src/PaymentRouter.sol#L206-L213)
	- [_settle(permit.permitted.token,sender,intent.refundTo,intent.fee,net,legs)](../src/PaymentRouter.sol#L129)
		- [messenger.depositForBurnWithHook(net,settlementDomain,to,token,to,0,STANDARD_FINALITY,hookData)](../src/PaymentRouter.sol#L246)
	Event emitted after the call(s):
	- [Burned(sender,token,net,fee,legs.length)](../src/PaymentRouter.sol#L238)
		- [_settle(permit.permitted.token,sender,intent.refundTo,intent.fee,net,legs)](../src/PaymentRouter.sol#L129)
	- [PaymentInitiated(legs[i].paymentId,sender,legs[i].receiver,token,legs[i].amount,refundTo,legs[i].travelRuleHash)](../src/PaymentRouter.sol#L234-L236)
		- [_settle(permit.permitted.token,sender,intent.refundTo,intent.fee,net,legs)](../src/PaymentRouter.sol#L129)

../src/PaymentRouter.sol#L114-L130


 - [ ] ID-8
Reentrancy in [PaymentRouter._settle(address,address,address,uint256,uint256,PaymentRouter.Leg[])](../src/PaymentRouter.sol#L228-L239):
	External calls:
	- [_burn(token,net,abi.encode(sender,refundTo,legs))](../src/PaymentRouter.sol#L232)
		- [messenger.depositForBurnWithHook(net,settlementDomain,to,token,to,0,STANDARD_FINALITY,hookData)](../src/PaymentRouter.sol#L246)
	Event emitted after the call(s):
	- [Burned(sender,token,net,fee,legs.length)](../src/PaymentRouter.sol#L238)
	- [PaymentInitiated(legs[i].paymentId,sender,legs[i].receiver,token,legs[i].amount,refundTo,legs[i].travelRuleHash)](../src/PaymentRouter.sol#L234-L236)

../src/PaymentRouter.sol#L228-L239


 - [ ] ID-9
Reentrancy in [PaymentRouter.payBatch(PaymentRouter.BatchIntent,ISignatureTransfer.PermitTransferFrom,address,bytes)](../src/PaymentRouter.sol#L134-L147):
	External calls:
	- [_pull(permit,sender,hashBatch(batch),BATCH_WITNESS,signature)](../src/PaymentRouter.sol#L145)
		- [permit2.permitWitnessTransferFrom(permit,ISignatureTransfer.SignatureTransferDetails({to:address(this),requestedAmount:permit.permitted.amount}),sender,witness,witnessType,signature)](../src/PaymentRouter.sol#L206-L213)
	- [_settle(permit.permitted.token,sender,batch.refundTo,batch.fee,net,batch.legs)](../src/PaymentRouter.sol#L146)
		- [messenger.depositForBurnWithHook(net,settlementDomain,to,token,to,0,STANDARD_FINALITY,hookData)](../src/PaymentRouter.sol#L246)
	Event emitted after the call(s):
	- [Burned(sender,token,net,fee,legs.length)](../src/PaymentRouter.sol#L238)
		- [_settle(permit.permitted.token,sender,batch.refundTo,batch.fee,net,batch.legs)](../src/PaymentRouter.sol#L146)
	- [PaymentInitiated(legs[i].paymentId,sender,legs[i].receiver,token,legs[i].amount,refundTo,legs[i].travelRuleHash)](../src/PaymentRouter.sol#L234-L236)
		- [_settle(permit.permitted.token,sender,batch.refundTo,batch.fee,net,batch.legs)](../src/PaymentRouter.sol#L146)

../src/PaymentRouter.sol#L134-L147


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-10
[ComplianceRegistry.isVerified(address)](../src/ComplianceRegistry.sol#L61-L64) uses timestamp for comparisons
	Dangerous comparisons:
	- [a.uid != bytes32(0) && a.expiresAt > block.timestamp](../src/ComplianceRegistry.sol#L63)

../src/ComplianceRegistry.sol#L61-L64


 - [ ] ID-11
[TronPaymentRouter._check(TronPaymentRouter.TronIntent)](../src/TronPaymentRouter.sol#L116-L124) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > intent.deadline](../src/TronPaymentRouter.sol#L122)

../src/TronPaymentRouter.sol#L116-L124


 - [ ] ID-12
[PaymentEscrow.claimRefundAfterTimeout(bytes32)](../src/PaymentEscrow.sol#L286-L290) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < p.escrowedAt + refundWindow](../src/PaymentEscrow.sol#L288)

../src/PaymentEscrow.sol#L286-L290


 - [ ] ID-13
[ComplianceRegistry.setAttestation(address,bytes32,uint64)](../src/ComplianceRegistry.sol#L47-L52) uses timestamp for comparisons
	Dangerous comparisons:
	- [expiresAt <= block.timestamp](../src/ComplianceRegistry.sol#L49)

../src/ComplianceRegistry.sol#L47-L52


 - [ ] ID-14
[ComplianceRegistry.isAllowed(address,address)](../src/ComplianceRegistry.sol#L71-L73) uses timestamp for comparisons
	Dangerous comparisons:
	- [isVerified(from) && isVerified(to) && ! isSanctioned(from) && ! isSanctioned(to)](../src/ComplianceRegistry.sol#L72)

../src/ComplianceRegistry.sol#L71-L73


## missing-inheritance
Impact: Informational
Confidence: High
 - [ ] ID-15
[ComplianceRegistry](../src/ComplianceRegistry.sol#L14-L88) should inherit from [ISanctionsList](../src/interfaces/ISanctionsList.sol#L5-L7)

../src/ComplianceRegistry.sol#L14-L88


## unused-state
Impact: Informational
Confidence: High
 - [ ] ID-16
[PaymentEscrow.HOOK_DATA](../src/PaymentEscrow.sol#L101) is never used in [PaymentEscrow](../src/PaymentEscrow.sol#L29-L419)

../src/PaymentEscrow.sol#L101


 - [ ] ID-17
[PaymentEscrow.BODY](../src/PaymentEscrow.sol#L99) is never used in [PaymentEscrow](../src/PaymentEscrow.sol#L29-L419)

../src/PaymentEscrow.sol#L99



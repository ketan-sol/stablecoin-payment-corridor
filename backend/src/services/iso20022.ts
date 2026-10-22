import type { counterparties, payments } from '../db/schema'
import { formatUnits6 } from './money'

type Payment = typeof payments.$inferSelect
type Counterparty = typeof counterparties.$inferSelect

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** ISO 20022 Max35Text: identifiers banks will accept. */
const max35 = (s: string) => s.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, '').slice(0, 35)

/**
 * pacs.008.001.08 (FI to FI customer credit transfer) for one payment, so the on-chain payment maps onto what banks
 * speak. The settlement leg is on-chain, recorded in SupplementaryData with the transaction hashes.
 */
export function pacs008(p: Payment, debtor: Counterparty, creditor: Counterparty, now = new Date()): string {
  const msgId = max35(`CORRIDOR-${p.id.replace(/-/g, '').slice(0, 24)}`)
  const endToEnd = max35(p.id.replace(/-/g, ''))
  const amount = formatUnits6(p.received ?? p.net, 2)
  const txs = [
    ['SourceBurn', p.payTx],
    ['EscrowFunded', p.receiveTx],
    ['EscrowReleased', p.releaseTx],
  ].filter(([, h]) => h)

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${now.toISOString().slice(0, 19)}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${esc(max35(p.invoiceRef))}</InstrId>
        <EndToEndId>${endToEnd}</EndToEndId>
        <UETR>${p.id}</UETR>
      </PmtId>
      <IntrBkSttlmAmt Ccy="USD">${amount}</IntrBkSttlmAmt>
      <IntrBkSttlmDt>${now.toISOString().slice(0, 10)}</IntrBkSttlmDt>
      <InstdAmt Ccy="USD">${formatUnits6(p.amount, 2)}</InstdAmt>${
        p.payoutCurrency !== 'USD' && p.fxRate ? `\n      <XchgRate>${p.fxRate}</XchgRate>` : ''
      }
      <ChrgBr>DEBT</ChrgBr>
      <ChrgsInf><Amt Ccy="USD">${formatUnits6(p.fee, 2)}</Amt><Agt><FinInstnId><Nm>Corridor</Nm></FinInstnId></Agt></ChrgsInf>
      <Dbtr><Nm>${esc(debtor.name)}</Nm><PstlAdr><Ctry>${esc(debtor.country)}</Ctry></PstlAdr></Dbtr>
      <DbtrAcct><Id><Othr><Id>${debtor.wallet}</Id><SchmeNm><Prtry>EVM</Prtry></SchmeNm></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><Nm>Corridor</Nm></FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId><Nm>${esc(creditor.bankAccount?.bankName ?? 'Corridor')}</Nm></FinInstnId></CdtrAgt>
      <Cdtr><Nm>${esc(creditor.name)}</Nm><PstlAdr><Ctry>${esc(creditor.country)}</Ctry></PstlAdr></Cdtr>
      <CdtrAcct><Id><Othr><Id>${esc(creditor.bankAccount?.accountNumber ?? creditor.wallet)}</Id></Othr></Id>${
        creditor.bankAccount ? `<Ccy>${esc(creditor.bankAccount.currency)}</Ccy>` : ''
      }</CdtrAcct>
      <RmtInf><Ustrd>${esc(p.invoiceRef)}</Ustrd></RmtInf>
      <SplmtryData>
        <PlcAndNm>OnChainSettlement</PlcAndNm>
        <Envlp>
          <PaymentId>${p.paymentId}</PaymentId>
          <TravelRuleHash>${p.travelRuleHash}</TravelRuleHash>
${txs.map(([k, h]) => `          <${k}>${h}</${k}>`).join('\n')}
        </Envlp>
      </SplmtryData>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
`
}

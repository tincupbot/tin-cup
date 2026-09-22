-- Settlement state for x402 payments.
--
-- WHY THIS EXISTS. Settling a payment is two facts that have to stay together:
-- money moved on chain, and we wrote it down. They are separated by a network
-- call and a database write, either of which can fail, and the failure that
-- matters is the asymmetric one — the chain settled and our append did not. The
-- payer is charged, the receipt exists on Base, and our books say nothing. On a
-- project whose entire claim is that the books are complete, a silent gap is
-- worse than a visible error.
--
-- 2026-09-22, and this is not hypothetical. That morning a Ko-fi donation was
-- POSTed to a hostname that had been switched off an hour earlier. The money
-- was fine; the bookkeeping never happened and nothing anywhere recorded that
-- it had been attempted. The lesson was not "check your webhooks" — it was that
-- an attempt must leave a trace before its outcome is known, or a lost outcome
-- is indistinguishable from an attempt that never happened.
--
-- So: `settlement` is written as 'attempted' BEFORE the facilitator is called,
-- and overwritten with the outcome after. A row left reading 'attempted' is the
-- alarm. It means we asked for money to move and never learned whether it did,
-- and it names the nonce to reconcile against the chain.
--
-- NULL means no settlement was ever attempted for this nonce — the endpoint was
-- running without a wallet and recorded a zero-amount `alms_offer` marker
-- instead. That is the historical state of every row written before today.

ALTER TABLE x402_nonces ADD COLUMN settlement TEXT;

-- The reconciliation query this table exists to make possible:
--   SELECT nonce, payer, seen_at FROM x402_nonces WHERE settlement = 'attempted';
CREATE INDEX IF NOT EXISTS idx_x402_nonces_settlement ON x402_nonces (settlement);

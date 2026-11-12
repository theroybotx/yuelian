BEGIN;
-- DELETE ... WHERE expires_at needs read permission on the predicate column.
-- The runtime still cannot enumerate nonce values or read other private tables.
GRANT SELECT(expires_at) ON private.request_nonces TO yuelian_runtime;
COMMIT;

// Compatibility entry point; recovery now shares the full suite's real
// business-account fixture, signed bridge and isolated database guards.
process.env.YUELIAN_TEST_DATABASE ||= 'yuelian_acceptance_recovery';
process.env.YUELIAN_TEST_PORT ||= '18901';
process.env.YUELIAN_TEST_OUTPUT ||= process.cwd()+'/output/recovery-tests';
process.env.YUELIAN_TEST_SUITE = 'recovery';
await import('../../tests/full/recovery.mjs');

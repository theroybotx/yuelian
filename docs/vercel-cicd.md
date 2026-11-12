# Vercel CI/CD candidate

Task: `t_1e8ef222`. Repository: `theroybotx/yuelian`. This is an implementation candidate, not a deployed or independently accepted release.

## Reproduce locally

Use Node `24.18.0` and the committed npm lockfiles in a fresh checkout. Do not copy the original dirty working tree or environment files.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix server --ignore-scripts --no-audit --no-fund
npm run lint
npm run test:unit
node --test tests/trial-worker.test.mjs
npm run build:vercel
npm run test:vercel
npm run build
```

Run commands separately when collecting diagnostic results. In CI every failure blocks deployment. The lint command currently exposes pre-existing violations and framework-rule applicability issues; no rules or failing tests have been suppressed to obtain a green run.

`build:vercel` deliberately refuses an existing gateway output. Preserve a prior task-owned `.vercel/output` under a new unused name on the same filesystem after checking its manifest, or use a fresh checkout. Do not delete unknown output. `test:vercel` imports both a source-staged adapter and the actual packaged handler, checks file hashes and exercises a local HTTP server including stop/restart. Backend responses in these tests are synthetic; they do not prove external connectivity, a working database, model access, or remote Vercel behavior.

`tests/provision-trial-accounts.test.mjs` creates a new guarded PostgreSQL rehearsal database and generates temporary trial credentials. It is not a pure unit/edge test. Only the separate disposable GitHub-hosted CI database job may run it for this workflow. Do not run it against a shared host or production database. The CI fixture is not yet remotely exercised.

## Configuration and trust

Vercel project: `prj_sClf94SbvxJ4cS3Etv6EnrQ9OrXR`, team slug `bigroy`. CLI `65.14.0`. Function runtime `nodejs24.x`; the existing remote project Node setting still needs reconciliation before execution.

Repository variables to configure using an authorized connection:

- `VERCEL_ORG_ID`: read back the authorized BIGROY team ID; do not guess it from the slug.
- `YUELIAN_RELEASE_BRANCH`: choose and protect the actual release branch. Empty means no branch-based production release; `main` is not implicitly approved.
- `YUELIAN_PRODUCTION_ORIGIN`: the exact existing HTTPS production origin, without a trailing slash.

CI secrets: `VERCEL_TOKEN`; `VERCEL_AUTOMATION_BYPASS_SECRET` only if deployment protection requires it. The workflow uses the built-in read-only GitHub token for provenance queries. No secret values belong in source, logs, build output, comments or this document. No account/secret/branch-protection settings were changed during local implementation.

Configure Preview and Production runtime values separately through existing safe storage:

- `YUELIAN_PUBLIC_ORIGIN`: exact HTTPS browser origin, without a trailing slash.
- `YUELIAN_BACKEND_URL`: independently verified HTTPS backend root origin, with no path prefix, query, fragment or credentials.
- `YUELIAN_STANDALONE_BRIDGE_SECRET`: the existing standalone bridge secret through its authorized secure channel. Never copy a Sites secret or publish its value.

The backend contract preserves `/v1` paths, UTF-8 body bytes, HMAC headers, audience `standalone:cloudflare-trial`, invite-only login, and HttpOnly business-session Cookies. A correctly transport-signed anonymous session GET returns HTTP 200 with `authenticated=false`; a direct unsigned backend request or unauthenticated business request is a different boundary.

Known unresolved runtime condition: the current handler uses one explicit public origin while every deployment has its own URL. A login-page GET cannot validate this condition. The release smoke also sends an invalid-content-type, same-origin POST that must fail locally with 415 before any backend call; an origin mismatch gives 403 and blocks promotion. CTO/backend must reconcile the exact Preview and staged Production origins, or provide a verified stable-origin strategy. Do not derive trust from arbitrary Host/forwarding headers or disable same-origin protection.

## Release policy

- PR/fork checks receive no Vercel deployment secrets. Deployment jobs only run on trusted pushes in the exact repository.
- Both normal checks and isolated database acceptance must succeed for the same commit.
- Production requires either the configured protected release branch or a protected exact `release-vX.Y.Z` tag. A matching tag name alone is insufficient; an owner must establish the actual protection rules. No rules were changed here.
- Preview pulls the exact branch environment. Production pulls and builds its own environment; Preview output is never reused for Production.
- The live Git ref is checked before upload and again before promotion. Current production provenance must be known and an ancestor of the candidate. A late older run cannot promote over a newer version. Deployment jobs serialize without cancelling an in-flight remote operation. Unknown upload outcomes are not automatically retried.
- Production is staged without domain assignment, smoke-tested, then promoted with exact deployment/alias readback. This is automated when the authorized conditions hold; it adds no per-release human approval.
- `vercel.json` disables the parallel Git deployment trigger only once the config is actually applied. Its local presence does not prove the remote Git integration is disabled.

**Empty-project bootstrap is unresolved.** Vercel documents that the first deployment is Production, even without `--prod`. Preview therefore refuses an empty project before upload. Reconcile a non-promoted bootstrap or another supported Preview-first path with CTO and the existing release authorization before any upload; do not quietly turn a Preview into the first production deployment.

## Evidence, recovery and independent QA

`build-manifest.json` records source commit, Node version and hashes of all packaged files. Freeze the source commit before the final build. Remote delivery must additionally record GitHub run URL/conclusion, deployment ID/URL/target/source metadata and exact alias readback. Local mocked tests do not establish any of those remote facts.

Current blockers: repository write permission; lint/code-owner resolution; a verified HTTPS backend origin; exact runtime-origin and empty-project bootstrap contracts; CI safe storage and release-source configuration; remote checks and independent QA. None should be bypassed for a successful deployment screenshot.

For pre-publication rollback, retain this candidate branch/patch and use a separate checkout of the previous commit. Do not reset the original dirty source tree. There is no deployment created by this implementation to roll back. After deployment, retain the previous known-good deployment/commit and use the authorized Vercel recovery operation; routine forward-only automation intentionally rejects a rollback candidate. Do not restore databases as part of an application rollback.

Independent QA should rerun the fixed commit, add adversarial cases, validate real login/session/origin and HMAC behavior with authorized isolated accounts, exercise failed/cancelled/stale CI, and verify actual Preview/Production deployment provenance. Author self-checks are not independent approval.

Official references: [deploy and first-deployment semantics](https://vercel.com/docs/cli/deploy), [Build Output API](https://vercel.com/docs/build-output-api), [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use).

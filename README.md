# @zincapp/znvault-migrate

Shared **MySQL** schema-migration library for ZnVault deployer tooling.

Extracts the migration engine (discover `.sql` files → plan pending/reconcile →
acquire lock → apply scaffolding helpers → run → reconcile → drop scaffolding →
track in `schema_migrations`) behind an engine-agnostic `EngineAdapter`
interface, so multiple deployer plugins and the `znvault` CLI can share one
proven migration runner.

> **Scope: MySQL only.** The `EngineAdapter` interface is engine-agnostic so a
> PostgreSQL adapter can be added later, but **no PostgreSQL adapter is built
> here** — `engine: 'postgres'` errors at validation. (PostgreSQL has an
> unsolved ownership-transfer-on-revoke problem that gets its own design.)

## Install

```bash
npm install @zincapp/znvault-migrate
```

## What it provides

- **`runMigrations(ctx, opts, deps)`** — the top-level entrypoint: mints a
  dynamic-secrets lease, opens a dedicated connection via the engine adapter,
  runs the migration engine, and revokes the lease (with a settle delay,
  revoke-retry, and SIGINT/SIGTERM handlers).
- **`MigrationRunner`** — the engine-agnostic orchestrator (`run()` / `status()`).
- **`mysqlAdapter`** — the MySQL `EngineAdapter` implementation.
- **`validateMigrationConfig(cfg)`** / **`MigrationConfig`** — config schema +
  validation (`engine` is required; `engine: 'postgres'` is rejected).

## Credential model

Credentials come **only** from a ZnVault dynamic-secrets lease (config carries a
`roleId`; there are no raw connection-string options). Every run mints an
ephemeral, audited lease and revokes it on exit — preserving the clean-revoke
posture the scaffolding design depends on.

## MySQL scaffolding (ER-4006)

MySQL's `DROP USER` fails (ER-4006 on 8.4) if the user is the `DEFINER` of any
stored routine. When a `scaffoldingFile` is configured, the lease user creates
the helper procedures at phase start and the runner drops every object that user
defines at phase end — so the ephemeral migrate user owns nothing on revoke and
`DROP USER` is always clean.

## Development

```bash
npm install
npm run build       # tsc
npm test            # vitest run (real-MySQL e2e self-skips without MYSQL_TEST_HOST)
npm run typecheck
npm run lint

# Run the real-MySQL-8.4 e2e + integration tests against a local MySQL:
MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=33306 MYSQL_TEST_DB=zincdb \
  MYSQL_TEST_USER=root MYSQL_TEST_PASSWORD=root npm test
```

## Release

Publishing is handled by GitHub Actions on a version tag (OIDC Trusted
Publishing — no npm token):

```bash
npm version patch   # or minor/major
git push origin main --tags
```

## License

MIT

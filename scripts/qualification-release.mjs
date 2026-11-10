#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, isDeepStrictEqual } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QUALIFICATION_CAP_BYTES = 128 * 1024 * 1024
const MAX_CPU_MS = 1000
const MAX_TEST_RECIPIENTS = 4
const WORKER = 'crykit-qualification'
const ORIGIN = 'https://qualify.crykit.lasers.app'
const CONFIG_ENV = 'CRYKIT_QUALIFICATION_DEPLOYMENT_CONFIG'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET_NAMES = Object.freeze(['OPAQUE_SERVER_SETUP', 'SESSION_SECRET', 'CURSOR_SECRET', 'CAPABILITY_SECRET', 'DUMMY_IDENTITY_SECRET', 'EMAIL_STATE_SECRET', 'SERVICE_BACKUP_KEY'])
const WORKER_ROUTES = Object.freeze(['/api/*', '/admin', '/admin/*'])
const BUCKET_BINDINGS = Object.freeze(['OBJECTS', 'LEDGER_BACKUPS', 'REVOCATION_LEDGER'])
const LIMITER_BINDINGS = Object.freeze(['CLOUD_NETWORK_LIMITER', 'CLOUD_ACCOUNT_LIMITER', 'CLOUD_AUTH_LIMITER', 'CLOUD_LOCATION_LIMITER'])
const VAR_NAMES = Object.freeze(['ACCOUNTS_ACTIVE', 'SIGNUP_ACTIVE', 'EMAIL_SENDING_ACTIVE', 'EMAIL_HEADROOM', 'SERVICE_ORIGIN', 'STORAGE_CAP_BYTES', 'EMAIL_FROM', 'ADMIN_ACCESS_CONFIG', 'SERVICE_BACKUP_POLICY'])
const CONFIG_KEYS = new Set(['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'observability', 'alias', 'build', 'assets', 'secrets', 'vars', 'limits', 'ratelimits', 'd1_databases', 'r2_buckets', 'send_email', 'triggers', 'routes', 'tail_consumers'])
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 512 * 1024
const API_TIMEOUT_MS = 20_000
const CHILD_TIMEOUT_MS = 5 * 60_000
const USAGE = `Usage: node scripts/qualification-release.mjs [-c|--config FILE] -i|--identity FILE [-n|--dry-run | -d|--deploy] [-h|--help]
Validate an explicit private qualification Wrangler JSON configuration; default is check only.
FILE must be an absolute, owner-only regular file outside source and build inputs.
Alternatively supply its JSON through ${CONFIG_ENV}; never supply both.
Identity FILE pins database UUID, limiter IDs and Access identity against the retained baseline.
Both files use owner-only JSON outside the checkout; identity is mandatory in every mode.
Required configuration and activation boundaries: docs/qualification-tooling.md.
--dry-run validates dist and bundles the production entry without provider writes.
--deploy uploads, checks the exact version, deploys it at 100%, and checks readback.
Only closed account/signup/email/confirmation gates, no backup policy and no schedules are accepted.
This command does not establish whole-host Access acceptance or authorize active qualification.
Build dist first with npm run build. Dry-run/deploy require npm ci and Node >=22.12.
Deploy requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with Workers edit/read
and read access to the configured D1/R2 resources. Original secrets must already exist;
this command never creates, rotates or reads secret values. It does not apply triggers.
Results are JSON on stdout; bounded phase diagnostics go to stderr. Private child output
is retained only in an owner-only temporary directory, never printed or uploaded.
Exit: 0 valid/deployed/help, 1 operation/readback failure, 2 invalid input, 3 missing dependencies.
`

class ReleaseError extends Error {
  constructor(message, exitCode = 2) { super(message); this.exitCode = exitCode }
}
function requireCondition(condition, message, exitCode = 2) {
  if (!condition) throw new ReleaseError(message, exitCode)
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => isDeepStrictEqual(a, b)
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every(value => a.includes(value))
function parsePrivateJson(text) {
  requireCondition(typeof text === 'string' && Buffer.byteLength(text) <= MAX_CONFIG_BYTES, 'Configuration is missing or exceeds its byte limit')
  try { return JSON.parse(text) } catch { throw new ReleaseError('Configuration must be valid JSON') }
}

export async function readPrivateConfig(path) {
  requireCondition(isAbsolute(path), 'Configuration path must be absolute')
  let file
  try {
    const info = await lstat(path)
    requireCondition(info.isFile() && !info.isSymbolicLink(), 'Configuration must be a regular file, not a symlink')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await file.stat()
    requireCondition(opened.isFile() && opened.uid === process.getuid() && (opened.mode & 0o077) === 0 && opened.size <= MAX_CONFIG_BYTES, 'Configuration must be owner-only and within its byte limit')
    return parsePrivateJson(await file.readFile('utf8'))
  } catch (error) {
    if (error instanceof ReleaseError) throw error
    throw new ReleaseError('Cannot read the protected configuration file')
  } finally { await file?.close() }
}

export function normalizeQualificationConfig(input, root, identity) {
  const identityKeys = ['version', 'workerName', 'origin', 'databaseId', 'limiterNamespaceIds', 'adminIssuer', 'adminAudience', 'confirmationAudience', 'excludedDatabaseIds', 'excludedLimiterNamespaceIds', 'excludedAccessAudiences']
  requireCondition(object(identity) && sameSet(Object.keys(identity), identityKeys) && identity.version === 1 && identity.workerName === WORKER && identity.origin === ORIGIN, 'A reviewed qualification identity inventory is required')
  const uniqueStrings = (values, pattern) => Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && pattern.test(value)) && new Set(values).size === values.length
  requireCondition(UUID.test(identity.databaseId) && uniqueStrings(identity.excludedDatabaseIds, UUID) && !identity.excludedDatabaseIds.includes(identity.databaseId), 'Qualification database must be distinct from baseline identities')
  requireCondition(uniqueStrings(identity.limiterNamespaceIds, /^\d+$/) && identity.limiterNamespaceIds.length === LIMITER_BINDINGS.length && uniqueStrings(identity.excludedLimiterNamespaceIds, /^\d+$/) && identity.limiterNamespaceIds.every(id => !identity.excludedLimiterNamespaceIds.includes(id)), 'Qualification limiter namespaces must be independent')
  requireCondition(uniqueStrings(identity.excludedAccessAudiences, /^[a-f0-9]{64}$/) && [identity.adminAudience, identity.confirmationAudience].every(value => /^[a-f0-9]{64}$/.test(value ?? '') && !identity.excludedAccessAudiences.includes(value)), 'Qualification audiences must be independent')
  // This inventory pins operator-approved identity; it does not establish live Access enforcement
  // Provider database name/UUID readback still occurs before any version upload

  requireCondition(object(input) && Object.keys(input).every(key => CONFIG_KEYS.has(key)), 'Unsupported or missing qualification configuration')
  requireCondition(input.name === WORKER && input.workers_dev === false && input.preview_urls === false, 'Qualification Worker identity or private ingress flags differ')
  requireCondition(input.observability?.enabled === false && input.observability.logs?.enabled === false && input.observability.logs?.invocation_logs === false && (input.observability.traces === undefined || input.observability.traces.enabled === false), 'Producer logs and traces must remain disabled')
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(input.compatibility_date ?? ''), 'A compatibility date is required')
  requireCondition(input.assets?.binding === 'ASSETS' && same(input.assets.run_worker_first, WORKER_ROUTES), 'API and admin routes must run the production Worker first')
  requireCondition(same(input.routes, [{ pattern: 'qualify.crykit.lasers.app', custom_domain: true }]), 'Qualification Custom Domain differs')
  requireCondition(sameSet(input.secrets?.required, SECRET_NAMES) && Object.keys(input.secrets).length === 1, 'Required original secret names differ')
  // Active qualification requires a measured ingress and shared effect-budget boundary
  // This closed-release checkpoint cannot enable accounts, mail, confirmation or maintenance
  requireCondition(['worker/index.ts', join(root, 'worker/index.ts')].includes(input.main), 'Qualification configuration must select the real serving entry')
  requireCondition(object(input.alias) && Object.keys(input.alias).length === 1 && ['.account-tests/opaque-runtime.js', './.account-tests/opaque-runtime.js', join(root, '.account-tests/opaque-runtime.js')].includes(input.alias['@serenity-kit/opaque']), 'Qualification aliases must select only the pinned OPAQUE adapter')
  const vars = input.vars
  requireCondition(object(vars) && Object.keys(vars).every(key => VAR_NAMES.includes(key)) && Object.values(vars).every(value => typeof value === 'string'), 'Runtime variables must contain only supported non-secret fields')
  requireCondition(vars.SERVICE_ORIGIN === ORIGIN, 'Qualification service origin differs')
  requireCondition(['ACCOUNTS_ACTIVE', 'SIGNUP_ACTIVE', 'EMAIL_SENDING_ACTIVE'].every(gate => vars[gate] === 'false') && vars.EMAIL_HEADROOM === 'unknown' && vars.SERVICE_BACKUP_POLICY === undefined, 'Qualification release supports only closed capabilities without backup admission')
  requireCondition(/^[1-9]\d*$/.test(vars.STORAGE_CAP_BYTES ?? '') && Number.isSafeInteger(Number(vars.STORAGE_CAP_BYTES)) && Number(vars.STORAGE_CAP_BYTES) <= QUALIFICATION_CAP_BYTES, 'Storage capacity must be an explicit positive byte ceiling')
  let admin
  try { admin = JSON.parse(vars.ADMIN_ACCESS_CONFIG) } catch { throw new ReleaseError('Admin Access configuration must be valid JSON') }
  requireCondition(admin?.version === 1 && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(admin.issuer ?? '') && admin.jwksUrl === `${admin.issuer}/cdn-cgi/access/certs`, 'Admin Access issuer and key source differ')
  requireCondition(/^[a-f0-9]{64}$/.test(admin.adminAudience ?? '') && /^[a-f0-9]{64}$/.test(admin.confirmationAudience ?? '') && admin.adminAudience !== admin.confirmationAudience && admin.confirmationEnabled === false, 'Admin Access requires distinct explicit audiences')
  requireCondition(admin.issuer === identity.adminIssuer && admin.adminAudience === identity.adminAudience && admin.confirmationAudience === identity.confirmationAudience, 'Qualification Access identity differs from reviewed inventory')
  requireCondition(input.d1_databases?.length === 1 && input.d1_databases[0].binding === 'DB' && input.d1_databases[0].database_id === identity.databaseId && input.d1_databases[0].database_name === 'crykit-qualification-metadata', 'An explicit qualification metadata database is required')
  requireCondition(Array.isArray(input.r2_buckets) && sameSet(input.r2_buckets.map(bucket => bucket.binding), BUCKET_BINDINGS) && input.r2_buckets.every(bucket => bucket.bucket_name === ({ OBJECTS: 'crykit-qualification-objects', LEDGER_BACKUPS: 'crykit-qualification-backups', REVOCATION_LEDGER: 'crykit-qualification-revocations' })[bucket.binding]) && new Set(input.r2_buckets.map(bucket => bucket.bucket_name)).size === BUCKET_BINDINGS.length, 'Distinct qualification object, backup and revocation buckets are required')
  requireCondition(input.r2_buckets.every(bucket => Object.keys(bucket).every(key => ['binding', 'bucket_name'].includes(key))), 'Qualification releases support only explicit default-jurisdiction R2 buckets')
  requireCondition(Array.isArray(input.ratelimits) && sameSet(input.ratelimits.map(rate => rate.name), LIMITER_BINDINGS) && new Set(input.ratelimits.map(rate => rate.namespace_id)).size === LIMITER_BINDINGS.length && input.ratelimits.every(rate => /^\d+$/.test(rate.namespace_id ?? '') && Number.isSafeInteger(rate.simple?.limit) && rate.simple.limit > 0 && [10, 60].includes(rate.simple.period)), 'Distinct explicit rate-limit bindings are required')
  requireCondition(same(LIMITER_BINDINGS.map(name => input.ratelimits.find(rate => rate.name === name).namespace_id), identity.limiterNamespaceIds), 'Qualification limiter identities differ from reviewed inventory')
  requireCondition(Number.isSafeInteger(input.limits?.cpu_ms) && input.limits.cpu_ms > 0 && input.limits.cpu_ms <= MAX_CPU_MS, 'An explicit Worker CPU ceiling is required')
  requireCondition(input.send_email?.length === 1 && input.send_email[0].name === 'NATIVE_EMAIL' && same(input.send_email[0].allowed_sender_addresses, [vars.EMAIL_FROM]) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vars.EMAIL_FROM ?? ''), 'The native email binding must restrict the configured sender')
  requireCondition(input.send_email[0].allowed_destination_addresses?.length > 0 && input.send_email[0].allowed_destination_addresses.length <= MAX_TEST_RECIPIENTS && new Set(input.send_email[0].allowed_destination_addresses).size === input.send_email[0].allowed_destination_addresses.length && input.send_email[0].allowed_destination_addresses.every(address => /^[a-z0-9][a-z0-9+._-]*@crykit\.lasers\.app$/.test(address)) && Object.keys(input.send_email[0]).every(key => ['name', 'allowed_sender_addresses', 'allowed_destination_addresses'].includes(key)), 'Qualification mail requires an exact authorized test-recipient allowlist')
  requireCondition(same(input.tail_consumers, [{ service: 'crykit-qualification-alerts' }]), 'The independent qualification alert consumer is required')
  requireCondition(Array.isArray(input.triggers?.crons) && input.triggers.crons.length === 0, 'Closed qualification maintenance must remain unscheduled')
  // Private configuration owns resource identity, never executable build paths
  // Normalizing these fields prevents a restored operator path from selecting stale or fixture code
  const config = structuredClone(input)
  delete config.$schema
  delete config.build
  config.main = join(root, 'worker/index.ts')
  config.alias = { '@serenity-kit/opaque': join(root, '.account-tests/opaque-runtime.js') }
  config.assets = { directory: join(root, 'dist'), binding: 'ASSETS', run_worker_first: [...WORKER_ROUTES] }
  config.observability = { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } }
  config.logpush = false
  config.d1_databases = config.d1_databases.map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id, migrations_dir: join(root, 'worker/migrations') }))
  config.secrets = { required: [...SECRET_NAMES] }
  return config
}

export function uploadedVersion(contents) {
  let records
  try { records = contents.split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { throw new ReleaseError('Upload did not produce valid structured records', 1) }
  const uploads = records.filter(record => record.type === 'version-upload')
  requireCondition(uploads.length === 1 && uploads[0].version === 1 && uploads[0].worker_name === WORKER && UUID.test(uploads[0].version_id), 'Expected one qualification version upload with an exact version ID', 1)
  return uploads[0].version_id
}

export function verifyBundle(metadata, root, configDirectory) {
  const entries = Object.values(metadata?.outputs ?? {}).filter(output => output.entryPoint)
  // Wrangler bases compiler paths on the config directory, which can differ in depth from the checkout
  // Resolving from the checkout can reject its own entry or mistake another checkout for this one
  requireCondition(entries.length === 1 && resolve(configDirectory, entries[0].entryPoint) === join(root, 'worker/index.ts') && entries[0].exports?.includes('default'), 'Release bundle does not use the production entry', 1)
  const inputs = Object.keys(metadata?.inputs ?? {})
  requireCondition(inputs.length > 0 && inputs.every(path => !/(^|\/)(?:worker\/testing|e2e|__accounts-proof)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path.replaceAll('\\', '/'))), 'Release bundle contains a test or fixture input', 1)
}

export function verifyVersion(version, config, versionId) {
  const fail = message => new ReleaseError(message, 1)
  if (version?.id !== versionId || !sameSet(version.resources?.script?.handlers, ['fetch', 'scheduled'])) throw fail('Uploaded version has the wrong identity or production handlers')
  const runtime = version.resources.script_runtime
  if (runtime?.compatibility_date !== config.compatibility_date || runtime?.limits?.cpu_ms !== config.limits.cpu_ms || !same(runtime?.assets?.raw_run_worker_first, WORKER_ROUTES)) throw fail('Uploaded version runtime or asset routing differs')
  const expected = [
    { name: 'ASSETS', type: 'assets' },
    ...SECRET_NAMES.map(name => ({ name, type: 'secret_text' })),
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...config.d1_databases.map(({ binding: name, database_id: id }) => ({ name, type: 'd1', id })),
    ...config.r2_buckets.map(({ binding: name, bucket_name }) => ({ name, type: 'r2_bucket', bucket_name })),
    ...config.ratelimits.map(({ name, namespace_id, simple }) => ({ name, type: 'ratelimit', namespace_id, simple })),
    ...config.send_email.map(binding => ({ ...binding, type: 'send_email' })),
  ]
  const bindings = version.resources.bindings
  if (!Array.isArray(bindings) || !sameSet(bindings.map(binding => binding.name), expected.map(binding => binding.name))) throw fail('Uploaded version binding inventory differs')
  for (const wanted of expected) {
    const actual = bindings.find(binding => binding.name === wanted.name)
    if (!Object.entries(wanted).every(([key, value]) => same(actual[key], value))) throw fail('Uploaded version binding identity, value or policy differs')
    if (wanted.type === 'd1' && actual.database_id !== undefined && actual.database_id !== wanted.id) throw fail('Uploaded database identity is ambiguous')
    if (wanted.type === 'r2_bucket' && actual.jurisdiction !== undefined && actual.jurisdiction !== '') throw fail('Uploaded object jurisdiction differs')
    if (wanted.type === 'send_email' && ['destination_address', 'allowed_destination_addresses', 'allowed_sender_addresses'].some(key => !same(actual[key], wanted[key]))) throw fail('Uploaded email restrictions differ')
  }
}

export async function verifyResources(config, readResource) {
  const db = config.d1_databases[0]
  const actual = await readResource(`/d1/database/${db.database_id}`)
  requireCondition(actual.name === db.database_name && actual.uuid === db.database_id, 'Qualification metadata resource differs', 1)
  for (const bucket of config.r2_buckets) requireCondition((await readResource(`/r2/buckets/${bucket.bucket_name}`)).name === bucket.bucket_name, 'Qualification object resource differs', 1)
}

export function verifyServingVersion(deployments, versionId) {
  const versions = deployments?.[0]?.versions
  requireCondition(Array.isArray(versions) && versions.length === 1 && versions[0].version_id === versionId && versions[0].percentage === 100, 'Serving deployment is not the exact uploaded version at full traffic', 1)
}

export async function releaseVersion(config, operations) {
  // Versions can become reachable before traffic assignment when provider preview ingress is enabled
  // Logging and Tail settings are non-versioned and must already be safe before uploading account code
  verifyWorkerState(await operations.worker(), config)
  const versionId = uploadedVersion(await operations.upload())
  verifyVersion(await operations.version(versionId), config, versionId)
  let reconciled = false
  try { await operations.deploy(versionId) } catch { reconciled = true }
  // An interrupted command may have committed the deployment; read serving authority before retrying
  verifyServingVersion(await operations.serving(), versionId)
  verifyWorkerState(await operations.worker(), config)
  return { worker: WORKER, versionId, percentage: 100, reconciled }
}

export function verifyWorkerState(worker, config) {
  // Version metadata can report has_preview while live preview ingress is disabled
  // Read the provider's ingress flags instead of treating that metadata as a reachable endpoint
  requireCondition(worker?.subdomain?.enabled === false && worker?.subdomain?.previews_enabled === false, 'Qualification alternate ingress is enabled or unestablished', 1)
  const observability = worker.observability
  // Worker details retain dormant invocation/persist defaults even with logs and traces disabled
  // Require all effective enablement flags, including Logpush, to be explicitly false
  requireCondition(observability?.enabled === false && observability.logs?.enabled === false && observability.traces?.enabled === false && worker.logpush === false, 'Qualification producer logging policy is unsafe or unestablished', 1)
  const consumers = worker.tail_consumers
  requireCondition(Array.isArray(consumers) && consumers.every(consumer => consumer.name === undefined || consumer.name === consumer.service) && same(consumers.map(({ service, environment }) => environment === undefined ? { service } : { service, environment }), config.tail_consumers), 'Qualification alert attachment differs', 1)
}

async function cli(args) {
  let values
  try {
    values = parseArgs({ args, strict: true, options: { help: { type: 'boolean', short: 'h' }, config: { type: 'string', short: 'c' }, identity: { type: 'string', short: 'i' }, 'dry-run': { type: 'boolean', short: 'n' }, deploy: { type: 'boolean', short: 'd' } } }).values
  } catch { throw new ReleaseError('Invalid arguments; use --help') }
  if (values.help) { process.stdout.write(USAGE); return }
  requireCondition(!(values.deploy && values['dry-run']), 'Select one mode')
  const fromEnv = process.env[CONFIG_ENV]
  requireCondition(Number(values.config !== undefined) + Number(fromEnv !== undefined) === 1 && values.config !== '', 'Provide exactly one explicit private configuration source; use --help')
  requireCondition(typeof values.identity === 'string' && values.identity.length > 0, 'Provide an explicit protected qualification identity file')
  for (const privatePath of [values.config, values.identity].filter(Boolean)) {
    let path
    try { path = await realpath(privatePath) } catch { throw new ReleaseError('Cannot locate the protected configuration file') }
    const source = await realpath(ROOT)
    requireCondition(!path.startsWith(source + '/') && path !== source, 'Private configuration must stay outside the source checkout')
  }
  const input = values.config ? await readPrivateConfig(values.config) : parsePrivateJson(fromEnv)
  const config = normalizeQualificationConfig(input, ROOT, await readPrivateConfig(values.identity))
  const mode = values.deploy ? 'deploy' : values['dry-run'] ? 'dry-run' : 'check'
  if (mode === 'check') { console.log(JSON.stringify({ worker: WORKER, mode, valid: true })); return }
  const wrangler = join(ROOT, 'node_modules/wrangler/bin/wrangler.js')
  try { await access(wrangler); await access(join(ROOT, 'node_modules/@serenity-kit/opaque/esm/index.js')) } catch { throw new ReleaseError('Pinned dependencies are missing; run npm ci', 3) }
  if (mode === 'deploy') requireCondition(/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '') && !!process.env.CLOUDFLARE_API_TOKEN, 'Deployment requires Cloudflare account credentials')
  const directory = await mkdtemp(join(tmpdir(), 'crykit-qualification-release-'))
  await chmod(directory, 0o700)
  const configPath = join(directory, 'wrangler.json')
  const outputPath = join(directory, 'upload.jsonl')
  const bundleMetadata = join(directory, 'bundle-meta.json')
  const diagnostics = join(directory, 'diagnostics.log')
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  await writeFile(outputPath, '', { mode: 0o600 })
  const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: outputPath, WRANGLER_LOG_PATH: directory }
  delete childEnv[CONFIG_ENV]
  if (mode === 'dry-run') { delete childEnv.CLOUDFLARE_API_TOKEN; delete childEnv.CLOUDFLARE_ACCOUNT_ID }
  const phase = async (name, work) => {
    const started = performance.now()
    process.stderr.write(JSON.stringify({ event: 'qualification-release', phase: name, status: 'started' }) + '\n')
    try {
      const result = await work()
      process.stderr.write(JSON.stringify({ event: 'qualification-release', phase: name, status: 'passed', durationMs: Math.round(performance.now() - started) }) + '\n')
      return result
    } catch (error) {
      process.stderr.write(JSON.stringify({ event: 'qualification-release', phase: name, status: 'failed', durationMs: Math.round(performance.now() - started), diagnostics }) + '\n')
      throw error instanceof ReleaseError ? error : new ReleaseError('Operation failed; inspect protected diagnostics or reproduce the dry-run locally', 1)
    }
  }
  const run = (name, argv) => phase(name, () => new Promise((done, fail) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS })
    let output = Buffer.alloc(0)
    const collect = chunk => { output = Buffer.concat([output, chunk]).subarray(-MAX_DIAGNOSTIC_BYTES) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', () => fail(new ReleaseError('Cannot start the pinned release dependency', 1)))
    child.once('close', async code => {
      if (code === 0) return done()
      try { await writeFile(diagnostics, output, { mode: 0o600 }) } catch { }
      fail(new ReleaseError(`Release subprocess failed with exit ${Number.isInteger(code) ? code : 'unknown'}`, 1))
    })
  }))
  const api = async path => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    requireCondition(response.ok && Number(response.headers.get('content-length') ?? 0) <= MAX_RESPONSE_BYTES, `Provider read failed (HTTP ${response.status})`, 1)
    const bytes = await response.arrayBuffer()
    requireCondition(bytes.byteLength <= MAX_RESPONSE_BYTES, 'Provider response exceeds its byte limit', 1)
    let body
    try { body = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new ReleaseError('Provider returned invalid JSON', 1) }
    requireCondition(body.success === true && body.result !== undefined, 'Provider could not establish release state', 1)
    return body.result
  }
  await run('validate-assets', [join(ROOT, 'scripts/check-assets.mjs')])
  await run('prepare-opaque', [join(ROOT, 'scripts/build-account-tests.mjs'), '--prepare-opaque'])
  // Wrangler exposes compiler metadata only through deploy, whose dry-run stops before provider writes
  // Live publication below still uploads and checks a version before assigning traffic
  await run('bundle-production', [wrangler, 'deploy', '--config', configPath, '--dry-run', '--outdir', join(directory, 'bundle'), '--metafile', bundleMetadata, '--upload-source-maps=false'])
  await phase('verify-bundle-inputs', async () => verifyBundle(JSON.parse(await readFile(bundleMetadata, 'utf8')), ROOT, directory))
  if (mode === 'dry-run') { console.log(JSON.stringify({ worker: WORKER, mode, valid: true })); return }
  await phase('verify-resources', () => verifyResources(config, api))
  const workerPath = `/workers/scripts/${WORKER}`
  const result = await releaseVersion(config, {
    upload: async () => {
      await writeFile(outputPath, '', { mode: 0o600 })
      await run('upload-version', [wrangler, 'versions', 'upload', '--config', configPath, '--upload-source-maps=false'])
      return readFile(outputPath, 'utf8')
    },
    version: id => phase('read-uploaded-version', () => api(`${workerPath}/versions/${id}`)),
    deploy: id => run('deploy-version', [wrangler, 'versions', 'deploy', `${id}@100%`, '--yes', '--config', configPath]),
    serving: () => phase('read-serving-version', async () => (await api(`${workerPath}/deployments`)).deployments),
    // The legacy script settings response omits observability even when the Worker details expose it
    worker: () => phase('read-worker-policy', () => api(`/workers/workers/${WORKER}`)),
  })
  console.log(JSON.stringify(result))
}

// Resolve invocation aliases so an absolute symlinked checkout path cannot silently skip the CLI
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof ReleaseError ? error.message : 'Qualification release failed without exposing private input')
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 1
  })
}

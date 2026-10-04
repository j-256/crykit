import { execFileSync, spawn } from 'node:child_process'
import { VerificationError } from './integration-verification.mjs'

const TOKEN_ENV = 'WT_QUEUE_VERIFICATION_TOKEN'
const UNCONFIGURED_EXIT = 5
const MAX_STATUS_BYTES = 1024 * 1024

export async function coordinateVerification(run, { cwd = process.cwd(), env = process.env,
  argv = [process.execPath, process.argv[1], ...process.argv.slice(2)], report = message => process.stderr.write(message + '\n') } = {}) {
  const command = env.CRYKIT_WT_QUEUE || 'wt-queue'
  if (env[TOKEN_ENV]) {
    let result
    try {
      result = JSON.parse(execFileSync(command, ['verification-status', '--json', '--token', env[TOKEN_ENV]],
        { cwd, env, encoding: 'utf8', maxBuffer: MAX_STATUS_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (error) { throw new VerificationError(`Cannot validate coordinated verification ownership: ${error.stderr?.toString().trim() || error.message}`, error.code === 'ENOENT' ? 3 : 2) }
    if (result.action !== 'owned') throw new VerificationError('The coordinator did not confirm ownership of this verification')
    return run()
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, ['verification-run', '--', ...argv], { cwd, env, stdio: 'inherit' })
    const stop = signal => child.kill(signal)
    const interrupt = () => stop('SIGINT')
    const terminate = () => stop('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    child.once('error', error => {
      cleanup()
      if (error.code === 'ENOENT' && !env.CRYKIT_WT_QUEUE) resolve({ unavailable: true })
      else reject(new VerificationError(`Unable to start verification coordinator: ${error.message}`, error.code === 'ENOENT' ? 3 : 1))
    })
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal }) })
  })
  if (result.unavailable || result.code === UNCONFIGURED_EXIT) {
    report('[verify] No configured wt-queue coordinator; running standalone verification')
    return run()
  }
  if (result.code !== 0) throw new VerificationError(`Coordinated verification stopped${result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}; inspect wt-queue verification-status --json`, result.code || 1)
  return { coordinated: true }
}

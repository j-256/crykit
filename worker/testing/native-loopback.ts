// Native shards can use separate loopback families without changing application origins or request transport
// Accept only loopback listeners so a test-runner setting cannot expose fixture controls to the network
export function nativeFixtureHost(family = process.env.CRYKIT_NATIVE_TEST_LOOPBACK): '127.0.0.1' | '::1' {
  if (family === undefined || family === '' || family === 'ipv4') return '127.0.0.1'
  if (family === 'ipv6') return '::1'
  throw new Error('CRYKIT_NATIVE_TEST_LOOPBACK must be ipv4 or ipv6')
}

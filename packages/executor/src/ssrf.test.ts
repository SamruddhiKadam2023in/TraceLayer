import {
  assertAllowedUrl,
  BlockedTargetError,
  createGuardedLookup,
  isBlockedAddress,
} from './ssrf';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS / GCP / Azure metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd00:ec2::254', // AWS IMDS over IPv6
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same, in hex form
    '::ffff:a9fe:a9fe', // mapped 169.254.169.254
    '64:ff9b::10.0.0.1', // NAT64 of a private address
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('refuses things that are not IP addresses', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
});

describe('assertAllowedUrl', () => {
  const check = (url: string, allowPrivateNetwork = false) =>
    assertAllowedUrl(new URL(url), { allowPrivateNetwork });

  it.each([
    'http://localhost:3000/',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0x7f.1/', // hex IPv4, normalised to 127.0.0.1 by the URL parser
    'http://2130706433/', // decimal IPv4 for 127.0.0.1
    'http://localhost./', // trailing dot
  ])('blocks %s', (url) => {
    expect(() => check(url)).toThrow(BlockedTargetError);
  });

  it('only allows http and https', () => {
    expect(() => check('ftp://example.com/')).toThrow('Only http and https');
    expect(() => check('file:///etc/passwd')).toThrow('Only http and https');
  });

  it('allows ordinary public hosts', () => {
    expect(() => check('https://api.example.com/v1')).not.toThrow();
    expect(() => check('http://93.184.216.34/')).not.toThrow();
  });

  it('allows private targets only when explicitly enabled', () => {
    expect(() => check('http://localhost:3000/', true)).not.toThrow();
    expect(() => check('ftp://localhost/', true)).toThrow('Only http and https');
  });
});

describe('createGuardedLookup', () => {
  const resolve = (hostname: string, allowPrivateNetwork = false) =>
    new Promise<string>((resolvePromise, reject) => {
      createGuardedLookup({ allowPrivateNetwork })(hostname, {}, (err, address) =>
        err ? reject(err) : resolvePromise(address as string),
      );
    });

  it('refuses a hostname that resolves to a private address', async () => {
    // "localhost" resolves via the hosts file, so this needs no network access.
    await expect(resolve('localhost')).rejects.toThrow(BlockedTargetError);
  });

  it('resolves normally when private targets are allowed', async () => {
    await expect(resolve('localhost', true)).resolves.toMatch(/^(127\.0\.0\.1|::1)$/);
  });
});

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
    // Phase 14: other spellings and IPv6 transition formats that carry an internal IPv4.
    '0:0:0:0:0:ffff:7f00:1', // mapped loopback, fully expanded
    '::ffff:0:7f00:1', // IPv4-translated (SIIT) form
    '64:ff9b:0:0:0:0:7f00:1', // NAT64 of 127.0.0.1, fully expanded
    '64:ff9b:1::a00:1', // local-use NAT64
    '::127.0.0.1', // deprecated IPv4-compatible form
    '::7f00:1', // the same, in hex
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2002:a9fe:a9fe::1', // 6to4 of the metadata address
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
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
    '2002:808:808::1', // 6to4 of a public address
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
    'http://0177.0.0.1/', // octal IPv4
    'http://127.1/', // short IPv4
    'http://0.0.0.0:8080/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped literal
    'http://[64:ff9b::7f00:1]/', // NAT64 literal of loopback
    'http://[2002:a9fe:a9fe::]/', // 6to4 literal of the metadata address
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

import { describe, it, expect } from 'vitest';
import {
  isDenylisted,
  normalizeDenylistEntry,
  BUILTIN_CHECKPOINT_HOSTS,
} from '@/shared/denylist';

describe('normalizeDenylistEntry', () => {
  it('strips scheme, path, port, wildcard, and lowercases', () => {
    expect(normalizeDenylistEntry('https://Example.com/path?q=1')).toBe('example.com');
    expect(normalizeDenylistEntry('  example.com:8080  ')).toBe('example.com');
    expect(normalizeDenylistEntry('*.example.com')).toBe('example.com');
    expect(normalizeDenylistEntry('.example.com')).toBe('example.com');
    expect(normalizeDenylistEntry('http://shop.example.org/')).toBe('shop.example.org');
  });

  it('returns empty for blank input', () => {
    expect(normalizeDenylistEntry('   ')).toBe('');
    expect(normalizeDenylistEntry('')).toBe('');
  });
});

describe('isDenylisted', () => {
  it('matches an exact host and its subdomains', () => {
    expect(isDenylisted('example.com', ['example.com'])).toBe(true);
    expect(isDenylisted('www.example.com', ['example.com'])).toBe(true);
    expect(isDenylisted('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('does NOT match unrelated or superstring hosts', () => {
    expect(isDenylisted('example.com', ['ple.com'])).toBe(false);
    expect(isDenylisted('notexample.com', ['example.com'])).toBe(false);
    expect(isDenylisted('example.com.evil.com', ['example.com'])).toBe(false);
    expect(isDenylisted('example.com', [])).toBe(false);
  });

  it('normalizes user entries before matching', () => {
    expect(isDenylisted('www.example.com', ['https://example.com/'])).toBe(true);
    expect(isDenylisted('EXAMPLE.com', ['Example.com'])).toBe(true);
  });

  it('always denylists built-in third-party challenge iframe hosts', () => {
    for (const host of BUILTIN_CHECKPOINT_HOSTS) {
      expect(isDenylisted(host)).toBe(true);
    }
    expect(isDenylisted('challenges.cloudflare.com')).toBe(true);
  });
});

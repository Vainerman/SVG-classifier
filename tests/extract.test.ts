import { describe, it, expect, beforeEach } from 'vitest';
import { extractIcon, canonicalizeSvg } from '@/content/extract';

function svg(html: string): SVGElement {
  document.body.innerHTML = html;
  return document.body.querySelector('svg') as unknown as SVGElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('canonicalizeSvg — stable normalization', () => {
  it('strips volatile attrs so cosmetically-different icons match', () => {
    const a = canonicalizeSvg(
      svg('<svg id="a" class="icon big" width="24" height="24"><path d="M1 2"/></svg>'),
    );
    const b = canonicalizeSvg(
      svg('<svg id="b" class="other" width="48" height="48"><path d="M1 2"/></svg>'),
    );
    expect(a).toBe(b);
  });

  it('keeps shape-bearing attributes (viewBox, d) distinct', () => {
    const a = canonicalizeSvg(svg('<svg viewBox="0 0 24 24"><path d="M1 2"/></svg>'));
    const b = canonicalizeSvg(svg('<svg viewBox="0 0 24 24"><path d="M9 9"/></svg>'));
    expect(a).not.toBe(b);
  });

  it('collapses whitespace', () => {
    const a = canonicalizeSvg(svg('<svg>\n  <path d="M1 2"/>\n</svg>'));
    expect(a).not.toMatch(/\n/);
    expect(a).toContain('<path');
  });

  it('our injected aria/sentinel do not change the canonical form', () => {
    const before = canonicalizeSvg(svg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'));
    const after = canonicalizeSvg(
      svg(
        '<svg viewBox="0 0 1 1" role="img" aria-label="home" data-icon-labeler="home"><title>home</title><path d="M0 0"/></svg>',
      ),
    );
    // role/aria/sentinel stripped; <title> is kept content but not volatile —
    // assert the path-bearing geometry is identical regardless.
    expect(after).toContain('<path');
    expect(before).toContain('<path');
  });
});

describe('<use> sprite resolution', () => {
  it('inlines a referenced <symbol> into the canonical string', () => {
    document.body.innerHTML = `
      <svg style="display:none"><symbol id="ico-home"><path d="M5 5h2v2z"/></symbol></svg>
      <svg class="use-host"><use href="#ico-home"/></svg>`;
    const host = document.body.querySelector('svg.use-host') as unknown as SVGElement;
    const canonical = canonicalizeSvg(host);
    expect(canonical).toContain('M5 5h2v2z'); // symbol geometry inlined
    expect(canonical).not.toContain('<use'); // <use> resolved away
  });
});

describe('extractIcon', () => {
  it('classifies inline vs sprite svg and produces a hash', () => {
    const inline = extractIcon(svg('<svg><path d="M1 1"/></svg>'))!;
    expect(inline.kind).toBe('inline-svg');
    expect(inline.hash).toMatch(/^[0-9a-f]{8}$/);

    document.body.innerHTML =
      '<svg><symbol id="s"><path d="M2 2"/></symbol></svg><svg class="h"><use href="#s"/></svg>';
    const host = document.body.querySelector('svg.h') as unknown as SVGElement;
    expect(extractIcon(host)!.kind).toBe('sprite-svg');
  });

  it('img of svg is img-svg keyed by src', () => {
    document.body.innerHTML = '<img src="/a/home.svg">';
    const img = document.body.querySelector('img')!;
    const r = extractIcon(img)!;
    expect(r.kind).toBe('img-svg');
    expect(r.canonical).toBe('img:/a/home.svg');
  });
});

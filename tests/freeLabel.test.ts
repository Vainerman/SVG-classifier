/**
 * The do-no-harm gate is the highest-value test surface: every case here is a
 * page we must NOT regress. Mislabeling an already-accessible icon is worse than
 * doing nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computeAccNameState } from '@/content/freeLabel';

const opts = { useFreeLabelHints: true };

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector('svg, img') as Element;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('computeAccNameState — do-no-harm', () => {
  it('bare inline <svg> is unlabeled (we should label it)', () => {
    expect(computeAccNameState(el('<svg><path d="M0 0h4v4z"/></svg>'), opts).state).toBe(
      'unlabeled',
    );
  });

  it('aria-hidden svg is hidden (decorative — skip)', () => {
    expect(computeAccNameState(el('<svg aria-hidden="true"><path/></svg>'), opts).state).toBe(
      'hidden',
    );
  });

  it('role=presentation svg is hidden', () => {
    expect(computeAccNameState(el('<svg role="presentation"><path/></svg>'), opts).state).toBe(
      'hidden',
    );
  });

  it('svg with its own aria-label is named (leave alone)', () => {
    expect(computeAccNameState(el('<svg aria-label="Home"><path/></svg>'), opts).state).toBe(
      'named',
    );
  });

  it('svg with a <title> child is named', () => {
    expect(
      computeAccNameState(el('<svg><title>Search</title><path/></svg>'), opts).state,
    ).toBe('named');
  });

  it('THE DOUBLE-SPEAK CASE: icon inside an aria-labelled button is named-by-ancestor', () => {
    const svg = el('<button aria-label="Go home"><svg><path/></svg></button>');
    expect(computeAccNameState(svg, opts).state).toBe('named-by-ancestor');
  });

  it('icon inside a button with visible text is named-by-ancestor', () => {
    const svg = el('<button><svg><path/></svg> Submit</button>');
    expect(computeAccNameState(svg, opts).state).toBe('named-by-ancestor');
  });

  it('icon-only button with NO other name is unlabeled (icon should supply the name)', () => {
    document.body.innerHTML = '<button><svg class="x"><path/></svg></button>';
    const svg = document.body.querySelector('svg')!;
    // No free-label hint on "x"; the icon must become the button's name.
    expect(computeAccNameState(svg, { useFreeLabelHints: false }).state).toBe('unlabeled');
  });

  it('bare <a href> wrapping an icon (no text) is unlabeled', () => {
    document.body.innerHTML = '<a href="/x"><svg><path/></svg></a>';
    const svg = document.body.querySelector('svg')!;
    expect(computeAccNameState(svg, { useFreeLabelHints: false }).state).toBe('unlabeled');
  });

  it('class="icon-home" yields a free-label', () => {
    const r = computeAccNameState(el('<svg class="icon-home"><path/></svg>'), opts);
    expect(r.state).toBe('free-label');
    expect(r.freeLabel).toBe('home');
  });

  it('data-icon="search" yields a free-label', () => {
    const r = computeAccNameState(el('<svg data-icon="search"><path/></svg>'), opts);
    expect(r.state).toBe('free-label');
    expect(r.freeLabel).toBe('search');
  });

  it('free-label hints can be disabled', () => {
    expect(
      computeAccNameState(el('<svg class="icon-home"><path/></svg>'), {
        useFreeLabelHints: false,
      }).state,
    ).toBe('unlabeled');
  });

  it('<img alt=""> (explicit decorative) is hidden', () => {
    expect(
      computeAccNameState(el('<img src="x.svg" alt="">'), opts).state,
    ).toBe('hidden');
  });

  it('<img> of svg with no alt yields a filename free-label', () => {
    const r = computeAccNameState(el('<img src="/icons/trash.svg">'), opts);
    expect(r.state).toBe('free-label');
    expect(r.freeLabel).toBe('trash');
  });

  it('<img> with a real alt is named', () => {
    expect(
      computeAccNameState(el('<img src="x.svg" alt="Delete item">'), opts).state,
    ).toBe('named');
  });
});

describe('computeAccNameState — existingName (debug "label all")', () => {
  it("exposes a named icon's own accessible name", () => {
    expect(
      computeAccNameState(el('<svg aria-label="Home"><path/></svg>'), opts).existingName,
    ).toBe('Home');
  });

  it("exposes a <title>-named icon's name", () => {
    expect(
      computeAccNameState(el('<svg><title>Search</title><path/></svg>'), opts).existingName,
    ).toBe('Search');
  });

  it("exposes the ancestor's name for a named-by-ancestor icon", () => {
    const svg = el('<button aria-label="Go home"><svg><path/></svg></button>');
    const r = computeAccNameState(svg, opts);
    expect(r.state).toBe('named-by-ancestor');
    expect(r.existingName).toBe('Go home');
  });

  it("exposes an ancestor's visible text for a named-by-ancestor icon", () => {
    const svg = el('<button><svg><path/></svg> Submit</button>');
    const r = computeAccNameState(svg, opts);
    expect(r.state).toBe('named-by-ancestor');
    expect(r.existingName).toBe('Submit');
  });

  it('is absent for genuinely unlabeled icons', () => {
    expect(
      computeAccNameState(el('<svg><path d="M0 0h4v4z"/></svg>'), opts).existingName,
    ).toBeUndefined();
  });
});

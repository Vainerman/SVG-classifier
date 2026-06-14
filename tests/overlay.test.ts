import { describe, it, expect, beforeEach } from 'vitest';
import { applyLabel, composeLabel } from '@/content/overlay';
import { isHandled } from '@/content/handled';
import { DEFAULT_BEHAVIOR, SENTINEL_ATTR } from '@/shared/config';
import type { ClassifyResult } from '@/shared/messages';

const settings = { ...DEFAULT_BEHAVIOR, debugBadge: false };
const result = (label: string): ClassifyResult => ({
  hash: 'deadbeef',
  label,
  confidence: 0.9,
  source: 'model',
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('composeLabel', () => {
  it('suffix mode appends the real attribution (MOCK_MODE is off)', () => {
    const d = composeLabel('home', {
      attribution: 'suffix',
      attributionText: '(auto-labeled)',
      mockAttributionText: '(mock label)',
    });
    expect(d.accessibleName).toBe('home (auto-labeled)');
    expect(d.badgeText).toBe('home');
  });

  it('roledescription mode keeps the name clean', () => {
    const d = composeLabel('home', {
      attribution: 'roledescription',
      attributionText: '(auto-labeled)',
      mockAttributionText: '(mock label)',
    });
    expect(d.accessibleName).toBe('home');
    expect(d.roleDescription).toBeTruthy();
  });

  it('none mode is just the label', () => {
    const d = composeLabel('home', {
      attribution: 'none',
      attributionText: '(auto-labeled)',
      mockAttributionText: '(mock label)',
    });
    expect(d.accessibleName).toBe('home');
  });
});

describe('applyLabel — persistent-mode aria injection', () => {
  it('inline svg gets role=img, aria-label, <title> — and NO sentinel attribute', () => {
    document.body.innerHTML = '<svg><path/></svg>';
    const svg = document.body.querySelector('svg')!;
    const wrote = applyLabel(svg, 'inline-svg', result('home'), settings);
    expect(wrote).toBe(true);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('home (auto-labeled)');
    expect(svg.querySelector('title')?.textContent).toBe('home (auto-labeled)');
    // Handled-state is off-DOM now: tracked in the WeakSet, never written as an
    // attribute (so page integrity monitors have nothing to hash).
    expect(svg.hasAttribute(SENTINEL_ATTR)).toBe(false);
    expect(isHandled(svg)).toBe(true);
  });

  it('is idempotent: re-applying the same label writes nothing new', () => {
    document.body.innerHTML = '<svg><path/></svg>';
    const svg = document.body.querySelector('svg')!;
    applyLabel(svg, 'inline-svg', result('home'), settings);
    const second = applyLabel(svg, 'inline-svg', result('home'), settings);
    expect(second).toBe(false);
    expect(svg.querySelectorAll('title')).toHaveLength(1);
  });

  it('img with empty alt gets alt set; existing role is preserved', () => {
    document.body.innerHTML = '<img src="x.svg">';
    const img = document.body.querySelector('img')!;
    applyLabel(img, 'img-svg', result('trash'), settings);
    expect(img.getAttribute('alt')).toBe('trash (auto-labeled)');
  });

  it('does not overwrite a pre-existing role on an svg', () => {
    document.body.innerHTML = '<svg role="presentation"><path/></svg>';
    const svg = document.body.querySelector('svg')!;
    applyLabel(svg, 'inline-svg', result('home'), settings);
    expect(svg.getAttribute('role')).toBe('presentation');
  });
});

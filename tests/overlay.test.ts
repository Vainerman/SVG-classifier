import { describe, it, expect, beforeEach } from 'vitest';
import { applyLabel, composeLabel, isHandled } from '@/content/overlay';
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
  it('suffix mode appends the mock suffix during the mock phase', () => {
    const d = composeLabel('home', {
      attribution: 'suffix',
      attributionText: '(auto-labeled)',
      mockAttributionText: '(mock label)',
    });
    // MOCK_MODE is true in this build.
    expect(d.accessibleName).toBe('home (mock label)');
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

describe('applyLabel — aria injection', () => {
  it('inline svg gets role=img, aria-label, <title>, and the sentinel', () => {
    document.body.innerHTML = '<svg><path/></svg>';
    const svg = document.body.querySelector('svg')!;
    const wrote = applyLabel(svg, 'inline-svg', result('home'), settings);
    expect(wrote).toBe(true);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('home (mock label)');
    expect(svg.querySelector('title')?.textContent).toBe('home (mock label)');
    expect(svg.getAttribute(SENTINEL_ATTR)).toBe('home');
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
    expect(img.getAttribute('alt')).toBe('trash (mock label)');
  });

  it('does not overwrite a pre-existing role on an svg', () => {
    document.body.innerHTML = '<svg role="presentation"><path/></svg>';
    const svg = document.body.querySelector('svg')!;
    applyLabel(svg, 'inline-svg', result('home'), settings);
    expect(svg.getAttribute('role')).toBe('presentation');
  });
});

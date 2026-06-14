import { describe, it, expect } from 'vitest';
import { parseLabels, type LabelsFile } from '@/offscreen/inference';

describe('parseLabels — rich labels.json → flat index-ordered names', () => {
  it('orders by index and humanizes names for screen readers', () => {
    const file: LabelsFile = {
      version: 1,
      labels: [
        { index: 2, name: 'arrow_right', display: 'arrow_right' },
        { index: 0, name: 'home' },
        { index: 1, name: 'shopping_cart', display: 'shopping_cart' },
      ],
    };
    expect(parseLabels(file)).toEqual(['home', 'shopping cart', 'arrow right']);
  });

  it('prefers display over name and fills gaps with unknown', () => {
    const file: LabelsFile = {
      version: 1,
      labels: [
        { index: 0, name: 'x', display: 'Close' },
        { index: 2, name: 'star' },
      ],
    };
    expect(parseLabels(file)).toEqual(['Close', 'unknown', 'star']);
  });
});

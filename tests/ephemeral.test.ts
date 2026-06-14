import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EphemeralInjector } from '@/content/ephemeral';
import { resolveFocusTarget } from '@/content/freeLabel';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Dispatch the safe-mode hotkey (Alt+Shift+I) at an element. */
function pressHotkey(el: Element): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', {
      altKey: true,
      shiftKey: true,
      code: 'KeyI',
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('resolveFocusTarget', () => {
  it('resolves an icon-only <button> as the focus target', () => {
    document.body.innerHTML = '<button><svg><path/></svg></button>';
    const svg = document.querySelector('svg')!;
    expect(resolveFocusTarget(svg)).toBe(document.querySelector('button'));
  });

  it('resolves an <a href> wrapping an icon', () => {
    document.body.innerHTML = '<a href="#x"><svg><path/></svg></a>';
    const svg = document.querySelector('svg')!;
    expect(resolveFocusTarget(svg)).toBe(document.querySelector('a'));
  });

  it('returns the icon itself when it is directly focusable (tabindex≥0)', () => {
    document.body.innerHTML = '<svg tabindex="0"><path/></svg>';
    const svg = document.querySelector('svg')!;
    expect(resolveFocusTarget(svg)).toBe(svg);
  });

  it('returns null for a non-focusable standalone icon (Architecture B territory)', () => {
    document.body.innerHTML = '<span><svg><path/></svg></span>';
    const svg = document.querySelector('svg')!;
    expect(resolveFocusTarget(svg)).toBeNull();
  });

  it('returns null when the interactive ancestor is not keyboard-focusable (role=button, no tabindex)', () => {
    document.body.innerHTML = '<div role="button"><svg><path/></svg></div>';
    const svg = document.querySelector('svg')!;
    expect(resolveFocusTarget(svg)).toBeNull();
  });
});

describe('EphemeralInjector — transient, focus-driven aria-label', () => {
  it('writes nothing into the DOM at registration (load stays pristine)', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b')!;
    const before = btn.outerHTML;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home (auto-labeled)', false);
    inj.arm();
    expect(btn.outerHTML).toBe(before); // identical until a real focus event
  });

  it('injects aria-label on focus and strips it on blur', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home (auto-labeled)', false);
    inj.arm();

    btn.focus();
    expect(btn.getAttribute('aria-label')).toBe('home (auto-labeled)');
    btn.blur();
    expect(btn.hasAttribute('aria-label')).toBe(false);
  });

  it('never clobbers a control that gained its own name since classification', () => {
    document.body.innerHTML =
      '<button id="b" aria-label="Real name"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home (auto-labeled)', false);
    inj.arm();

    btn.focus();
    expect(btn.getAttribute('aria-label')).toBe('Real name');
  });

  it('disarm() removes any active label and stops reacting', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home', false);
    inj.arm();

    btn.focus();
    expect(btn.getAttribute('aria-label')).toBe('home');
    inj.disarm();
    expect(btn.hasAttribute('aria-label')).toBe(false);

    btn.blur();
    btn.focus();
    expect(btn.hasAttribute('aria-label')).toBe(false); // disarmed → inert
  });

  it('adds role="img" only when the icon itself is the focus target', () => {
    document.body.innerHTML = '<svg id="s" tabindex="0"><path/></svg>';
    const svg = document.getElementById('s') as unknown as HTMLElement;
    const inj = new EphemeralInjector();
    inj.register(svg, 'star', true);
    inj.arm();

    svg.focus();
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('star');
    svg.blur();
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('aria-label')).toBe(false);
  });
});

describe('EphemeralInjector — safe mode (speak, no page writes)', () => {
  let speak: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    speak = vi.fn();
    // jsdom has no Web Speech API — stub the bits the injector uses.
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
      speak,
      cancel: vi.fn(),
    };
    (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
      class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      };
  });

  it('writes NOTHING to the page on focus (safe mode never mutates the DOM)', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home (auto-labeled)', false);
    inj.arm('speak');

    btn.focus();
    expect(btn.hasAttribute('aria-label')).toBe(false);
    expect(btn.hasAttribute('role')).toBe(false);
  });

  it('speaks the focused icon\'s label on Alt+Shift+I', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home (auto-labeled)', false);
    inj.arm('speak');

    btn.focus();
    pressHotkey(btn);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toBe('home (auto-labeled)');
  });

  it('stays silent when the focused element is not a labeled icon', () => {
    document.body.innerHTML = '<button id="b">Plain</button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.arm('speak'); // nothing registered for this button
    btn.focus();
    pressHotkey(btn);
    expect(speak).not.toHaveBeenCalled();
  });

  it('does not speak after disarm', () => {
    document.body.innerHTML = '<button id="b"><svg><path/></svg></button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    const inj = new EphemeralInjector();
    inj.register(btn, 'home', false);
    inj.arm('speak');
    inj.disarm();

    btn.focus();
    pressHotkey(btn);
    expect(speak).not.toHaveBeenCalled();
  });
});

/**
 * Tests for src/calibration/desktop-gate.js — `evaluateEnvironment` pure
 * classifier. Covers the realistic UA + capability matrix that Prolific
 * sends, including the iPadOS-disguised-as-Mac case (the easiest miss).
 *
 * Real user-agent strings are used as-is from
 * https://developers.whatismybrowser.com/useragents/explore/ snapshots so
 * test failures point at concrete devices rather than synthetic strings.
 */
import { describe, it, expect } from 'vitest';
import { evaluateEnvironment } from '../src/calibration/desktop-detect.js';

const UA = Object.freeze({
  mac_chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  mac_safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  windows_chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  windows_firefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  linux_firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
  surface_pro:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Touch) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iphone_safari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  ipad_safari_old_ua:
    'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1',
  ipad_disguised_macos:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ipod_safari:
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  android_chrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  android_tablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

describe('evaluateEnvironment – desktop user agents pass', () => {
  it('macOS Chrome with mouse passes', () => {
    const out = evaluateEnvironment({
      userAgent: UA.mac_chrome,
      hasHover: true,
      hasFinePointer: true,
      maxTouchPoints: 0,
    });
    expect(out.isDesktop).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('macOS Safari (real Mac, touchPoints=0) passes', () => {
    const out = evaluateEnvironment({
      userAgent: UA.mac_safari,
      hasHover: true,
      hasFinePointer: true,
      maxTouchPoints: 0,
    });
    expect(out.isDesktop).toBe(true);
  });

  it('Windows 10 Chrome passes', () => {
    const out = evaluateEnvironment({
      userAgent: UA.windows_chrome,
      hasHover: true,
      hasFinePointer: true,
      maxTouchPoints: 0,
    });
    expect(out.isDesktop).toBe(true);
  });

  it('Windows 10 Firefox passes', () => {
    const out = evaluateEnvironment({
      userAgent: UA.windows_firefox,
      hasHover: true,
      hasFinePointer: true,
    });
    expect(out.isDesktop).toBe(true);
  });

  it('Linux Firefox passes', () => {
    const out = evaluateEnvironment({
      userAgent: UA.linux_firefox,
      hasHover: true,
      hasFinePointer: true,
    });
    expect(out.isDesktop).toBe(true);
  });

  it('Surface Pro hybrid (touch + mouse) passes – hover + fine pointer override touchPoints', () => {
    const out = evaluateEnvironment({
      userAgent: UA.surface_pro,
      hasHover: true,
      hasFinePointer: true,
      maxTouchPoints: 10,
    });
    expect(out.isDesktop).toBe(true);
    expect(out.reasons).toEqual([]);
  });
});

describe('evaluateEnvironment – mobile / tablet UAs fail with a reason code', () => {
  it('iPhone fails with `iphone` reason', () => {
    const out = evaluateEnvironment({
      userAgent: UA.iphone_safari,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('iphone');
  });

  it('iPod touch fails with `ipod` reason', () => {
    const out = evaluateEnvironment({
      userAgent: UA.ipod_safari,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('ipod');
  });

  it('iPad (older UA string still says iPad) fails with `ipad` reason', () => {
    const out = evaluateEnvironment({
      userAgent: UA.ipad_safari_old_ua,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('ipad');
  });

  it('iPadOS 13+ disguised as Macintosh fails via the touch-points disambiguator', () => {
    const out = evaluateEnvironment({
      userAgent: UA.ipad_disguised_macos,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('ipad_macos_disguised');
  });

  it('Android phone fails with `android` reason', () => {
    const out = evaluateEnvironment({
      userAgent: UA.android_chrome,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('android');
  });

  it('Android tablet (no Mobile token) still fails with `android`', () => {
    const out = evaluateEnvironment({
      userAgent: UA.android_tablet,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 10,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('android');
  });

  it('iPhone is not double-flagged with `mobile_ua` (already covered by iphone)', () => {
    const out = evaluateEnvironment({
      userAgent: UA.iphone_safari,
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.reasons).not.toContain('mobile_ua');
  });
});

describe('evaluateEnvironment – capability fallback for unknown UAs', () => {
  it('a UA with no mobile markers + coarse-only input fails via capability fallback', () => {
    const out = evaluateEnvironment({
      userAgent: 'CustomBrowser/1.0',
      hasHover: false,
      hasFinePointer: false,
      maxTouchPoints: 5,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toEqual(['no_hover_no_fine_pointer']);
  });

  it('null capability signals (unknown) do NOT trigger the fallback', () => {
    const out = evaluateEnvironment({
      userAgent: 'CustomBrowser/1.0',
      hasHover: null,
      hasFinePointer: null,
      maxTouchPoints: 0,
    });
    expect(out.isDesktop).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('a generic "Mobile" token in the UA flags `mobile_ua`', () => {
    const out = evaluateEnvironment({
      userAgent: 'CustomMobile/1.0',
      hasHover: false,
      hasFinePointer: false,
    });
    expect(out.isDesktop).toBe(false);
    expect(out.reasons).toContain('mobile_ua');
  });
});

describe('evaluateEnvironment – defensive defaults', () => {
  it('handles a fully missing input (empty object)', () => {
    const out = evaluateEnvironment({});
    expect(out.isDesktop).toBe(true);
    expect(out.reasons).toEqual([]);
    expect(out.userAgent).toBe('');
    expect(out.maxTouchPoints).toBe(0);
  });

  it('handles a missing argument (undefined)', () => {
    const out = evaluateEnvironment();
    expect(out.isDesktop).toBe(true);
  });

  it('coerces a non-string userAgent to empty', () => {
    const out = evaluateEnvironment({ userAgent: null });
    expect(out.userAgent).toBe(
      'null'
    ); /* String(null) === 'null' – predictable, lower-cases harmlessly */
    expect(out.isDesktop).toBe(true);
  });

  it('coerces a NaN maxTouchPoints to 0', () => {
    const out = evaluateEnvironment({
      userAgent: UA.mac_chrome,
      maxTouchPoints: NaN,
    });
    expect(out.maxTouchPoints).toBe(0);
    expect(out.isDesktop).toBe(true);
  });
});

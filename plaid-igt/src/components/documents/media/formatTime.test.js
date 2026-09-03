import { describe, it, expect } from 'vitest';
import { formatTime } from './formatTime.js';

describe('formatTime', () => {
  it('shows milliseconds, always', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(3.417)).toBe('0:03.417');
    expect(formatTime(65.5)).toBe('1:05.500');
  });

  it('rounds to the nearest millisecond and carries into the seconds', () => {
    expect(formatTime(59.9996)).toBe('1:00.000');
    expect(formatTime(0.0004)).toBe('0:00.000');
  });

  it('adds an hours field only once a recording is that long', () => {
    expect(formatTime(3599.999)).toBe('59:59.999');
    expect(formatTime(3600)).toBe('1:00:00.000');
    expect(formatTime(3725.25)).toBe('1:02:05.250');
  });

  it('treats missing or negative input as the start', () => {
    expect(formatTime(undefined)).toBe('0:00.000');
    expect(formatTime(NaN)).toBe('0:00.000');
    expect(formatTime(-2)).toBe('0:00.000');
  });
});

import { describe, it, expect } from 'vitest';
import { formatTime, parseTime } from './formatTime.js';

describe('parseTime', () => {
  it('reads what formatTime writes, and bare seconds', () => {
    expect(parseTime('0:03.417')).toBe(3.417);
    expect(parseTime('1:05.500')).toBe(65.5);
    expect(parseTime('1:02:05.250')).toBe(3725.25);
    expect(parseTime('65.25')).toBe(65.25);
    expect(parseTime('7')).toBe(7);
    expect(parseTime(' 0:03 ')).toBe(3);
  });

  it('pads a short fraction as decimal digits, not as milliseconds', () => {
    expect(parseTime('3.5')).toBe(3.5);
    expect(parseTime('0:03.4')).toBe(3.4);
    expect(parseTime('0:03.41')).toBe(3.41);
  });

  it('rejects text that is not a time', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:75.000')).toBeNull();
    expect(parseTime('1:75:00.000')).toBeNull();
    expect(parseTime('3.4567')).toBeNull();
    expect(parseTime('-2')).toBeNull();
  });

  it('round-trips through formatTime', () => {
    for (const s of [0, 0.001, 59.999, 60, 3599.999, 3600, 3725.25]) {
      expect(parseTime(formatTime(s))).toBe(s);
    }
  });
});

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

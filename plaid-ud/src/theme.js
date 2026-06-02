import { createTheme } from '@mantine/core';

// Mantine wants a 10-shade tuple per named color (index 0 lightest → 9 darkest)
// and uses `primaryShade` (default 6) as the "action" shade. The app's original
// Tailwind palette used the 600 step for primary actions, which lands exactly on
// index 6 — so these are the standard Tailwind scales, keeping the look faithful.
const blue = [
  '#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa',
  '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a',
];
const gray = [
  '#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af',
  '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827',
];
const red = [
  '#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171',
  '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d',
];
const green = [
  '#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80',
  '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d',
];
const orange = [
  '#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c',
  '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12',
];
const yellow = [
  '#fefce8', '#fef9c3', '#fef08a', '#fde047', '#facc15',
  '#eab308', '#ca8a04', '#a16207', '#854d0e', '#713f12',
];

export const theme = createTheme({
  primaryColor: 'blue',
  primaryShade: 6,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  colors: { blue, gray, red, green, orange, yellow },
});

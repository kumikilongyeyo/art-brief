import type { Theme } from './types';

interface Themable {
  tags?: string[];
  themes?: string[];
}

/** Empty themes list fits everything; otherwise the theme id or one of its allowTags must match. */
export function isOnTheme(e: Themable, theme: Theme): boolean {
  if (!e.themes || e.themes.length === 0) return true;
  if (e.themes.includes(theme.id)) return true;
  return (e.tags ?? []).some((t) => theme.allowTags.includes(t));
}

export function isBlocked(e: Themable, theme: Theme): boolean {
  return (e.tags ?? []).some((t) => theme.blockTags.includes(t));
}

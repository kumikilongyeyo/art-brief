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

/**
 * Written for this theme, not just allowed in it: the theme id is listed or one of its allowTags is
 * present. Theme-free entries are on-theme (see isOnTheme) but not themed, so they don't get the
 * THEME_BOOST and can't crowd out the lines that actually carry the theme.
 */
export function isThemed(e: Themable, theme: Theme): boolean {
  if (e.themes?.includes(theme.id)) return true;
  return (e.tags ?? []).some((t) => theme.allowTags.includes(t));
}

export function isBlocked(e: Themable, theme: Theme): boolean {
  return (e.tags ?? []).some((t) => theme.blockTags.includes(t));
}

/** Local identity for presence: a friendly random name and a stable cursor color. */

// Categorical hues validated for color-vision deficiency, with light tints for selections.
export const CURSOR_COLORS = [
  { color: '#2a78d6', light: '#2a78d633' },
  { color: '#eb6834', light: '#eb683433' },
  { color: '#1baf7a', light: '#1baf7a33' },
  { color: '#6250d6', light: '#6250d633' },
  { color: '#e87ba4', light: '#e87ba433' },
  { color: '#008300', light: '#00830033' },
  { color: '#e34948', light: '#e3494833' },
  { color: '#eda100', light: '#eda10033' },
] as const;

const ADJECTIVES = ['Brave', 'Calm', 'Clever', 'Gentle', 'Lucky', 'Quick', 'Sunny', 'Witty'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Lynx', 'Heron', 'Koala', 'Fox', 'Orca'];

export interface Identity {
  name: string;
  color: string;
  colorLight: string;
}

const KEY = 'inkwell:identity';

export function randomIdentity(random: () => number = Math.random): Identity {
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const c = pick(CURSOR_COLORS);
  return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: c.color, colorLight: c.light };
}

export function loadIdentity(): Identity {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Identity | null;
    if (stored?.name && stored.color) return stored;
  } catch {
    /* storage unavailable */
  }
  const fresh = randomIdentity();
  saveIdentity(fresh);
  return fresh;
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* ignore */
  }
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

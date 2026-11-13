// The Bitfocus tab edits Companion 5.0, 5.1 and 5.2. Their editing calls
// differ a little, so each has an adapter; the running version picks one and
// a probe of the calls it needs confirms it (see adapters.ts). Anything
// older, or a newer release whose calls or replies changed, is shown read
// only.

export interface CompanionVersion {
    major: number;
    minor: number;
    patch: number;
    // As Companion reported it, e.g. "5.1.2+10019-stable-98d5d4e1a1"
    raw: string;
}

export type Generation = 'trpc-5.0' | 'trpc-5.1' | 'trpc-5.2';

// "5.1.2", "v5.1.2", "5.1.2+10019-stable-98d5d4e1a1", "5.1.0-beta.3"
export function parseVersion(raw: unknown): CompanionVersion | null {
    if (typeof raw !== 'string') return null;
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3] ?? 0),
        raw: raw.trim(),
    };
}

const at = (v: CompanionVersion, major: number, minor: number) =>
    v.major > major || (v.major === major && v.minor >= minor);

// Newest release the adapters were tested against end to end. A newer one
// (5.2 until a stable 5.2 is out) still edits when its probe and reply-shape
// check pass, but the tab marks it untested.
const NEWEST_TESTED = { major: 5, minor: 1, patch: 3 };

export function isUntested(v: CompanionVersion): boolean {
    const t = NEWEST_TESTED;
    if (v.major !== t.major) return v.major > t.major;
    if (v.minor !== t.minor) return v.minor > t.minor;
    return v.patch > t.patch;
}

// The adapter written for this version, or null before 5.0. A version newer
// than 5.2 maps to the 5.2 adapter; the probe and the reply-shape check then
// decide whether it fits.
export function generationFor(v: CompanionVersion): Generation | null {
    if (!at(v, 5, 0)) return null;
    if (!at(v, 5, 1)) return 'trpc-5.0';
    if (!at(v, 5, 2)) return 'trpc-5.1';
    return 'trpc-5.2';
}

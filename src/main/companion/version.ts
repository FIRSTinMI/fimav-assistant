// The Bitfocus tab edits Companion 5.0 and 5.1. Their editing calls differ in
// one procedure, so each has an adapter; the running version picks one and a
// probe of the calls it needs confirms it (see adapters.ts). Anything older,
// or a newer release whose calls changed, is shown read only.

export interface CompanionVersion {
    major: number;
    minor: number;
    patch: number;
    // As Companion reported it, e.g. "5.1.2+10019-stable-98d5d4e1a1"
    raw: string;
}

export type Generation = 'trpc-5.0' | 'trpc-5.1';

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

// The adapter written for this version, or null before 5.0. A version newer
// than 5.1 maps to the 5.1 adapter; the probe then decides whether it fits.
export function generationFor(v: CompanionVersion): Generation | null {
    if (!at(v, 5, 0)) return null;
    if (!at(v, 5, 1)) return 'trpc-5.0';
    return 'trpc-5.1';
}

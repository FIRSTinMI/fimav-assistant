// Companion's editing API has changed shape several times. Each generation
// below is one API the Bitfocus tab knows how to drive; the running version
// picks one, and a probe of the calls it needs confirms it (see adapters.ts).

export interface CompanionVersion {
    major: number;
    minor: number;
    patch: number;
    // As Companion reported it, e.g. "4.2.6+8302-stable-1b9f2e4d"
    raw: string;
}

export type Generation =
    // socket.io. 3.0-3.1 address buttons as "bank:<page>-<bank>"; 3.2 by
    // grid location; 3.3 sends call arguments as one array; 3.5 adds an owner
    // argument to action:add; 4.0 replaces actions with entities.
    | 'sio-3.0'
    | 'sio-3.2'
    | 'sio-3.3'
    | 'sio-3.5'
    | 'sio-4.0'
    // tRPC, one generation per range whose procedures differ
    | 'trpc-4.1'
    | 'trpc-4.3'
    | 'trpc-5.0'
    | 'trpc-5.1';

// "4.2.6", "v4.2.6", "4.2.6+8302-stable-1b9f2e4d", "5.0.0-beta.3"
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

// The generation written for this version, or null when the version is older
// than any adapter. A version newer than the newest adapter maps to the
// newest one; the probe then decides whether it still fits.
export function generationFor(v: CompanionVersion): Generation | null {
    if (!at(v, 3, 0)) return null;
    if (!at(v, 3, 2)) return 'sio-3.0';
    if (!at(v, 3, 3)) return 'sio-3.2';
    if (!at(v, 3, 5)) return 'sio-3.3';
    if (!at(v, 4, 0)) return 'sio-3.5';
    if (!at(v, 4, 1)) return 'sio-4.0';
    if (!at(v, 4, 3)) return 'trpc-4.1';
    if (!at(v, 5, 0)) return 'trpc-4.3';
    if (!at(v, 5, 1)) return 'trpc-5.0';
    return 'trpc-5.1';
}

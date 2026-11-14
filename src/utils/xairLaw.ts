// Behringer X-Air (XR12/16/18) parameter laws, no Node imports: used by
// the main process (checks/xair.ts) and the UI's on-screen fader.

// X-Air fader and send levels (0..1) to dB, the X32/X-Air fader law: four
// straight lines meeting at -60, -30 and -10 dB, 0.75 = 0 dB, 1.0 = +10 dB.
// From Behringer's X-Air Parameters.txt ("fader/level parameter: dblevel =
// 40 * idx / (steps - 1) - 30 if idx >= steps / 2 ...", float = idx /
// (steps - 1)), the same law as Maillot's X32 OSC protocol appendix.
export function levelToDb(f: number): number {
    if (f <= 0) return -Infinity;
    if (f >= 0.5) return f * 40 - 30;
    if (f >= 0.25) return f * 80 - 50;
    if (f >= 0.0625) return f * 160 - 70;
    return f * 480 - 90;
}

// Steps of a fader (channel, return, bus, LR) and of a send level.
export const FADER_STEPS = 1024;
export const LEVEL_STEPS = 161;

// Highest a fader or send goes.
export const MAX_DB = 10;

// Preamp gain (/headamp/NN/gain): -12..+60 dB, linear, 145 steps.
export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 60;
export const GAIN_STEPS = 145;

export const gainToLevel = (db: number) => {
    const f =
        (Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db)) - GAIN_MIN_DB) /
        (GAIN_MAX_DB - GAIN_MIN_DB);
    return Math.round(f * (GAIN_STEPS - 1)) / (GAIN_STEPS - 1);
};

export const levelToGain = (f: number) =>
    GAIN_MIN_DB + f * (GAIN_MAX_DB - GAIN_MIN_DB);

// dB to the X-Air float, the inverse of levelToDb, rounded to the nearest
// step the mixer has (so the value read back is the value written).
// -Infinity (or under -90) is 0, off.
export function dbToLevel(db: number, steps: number): number {
    if (!(db > -90)) return 0;
    const d = Math.min(db, MAX_DB);
    let f: number;
    if (d < -60) f = (d + 90) / 480;
    else if (d < -30) f = (d + 70) / 160;
    else if (d < -10) f = (d + 50) / 80;
    else f = (d + 30) / 40;
    return Math.round(f * (steps - 1)) / (steps - 1);
}

// An input gain the wizard can set: a channel's mic preamp
// (/headamp/NN/gain, NN the channel's input) or, for a channel fed from a
// USB return, its return trim. `refDb` is the gain the talking gate
// (-40 dBFS on the input meter) is meant at: a level read at another gain
// is taken back to it, so turning a mic up does not make quieter talking
// count, nor turning it down hide talking.
export interface GainControl {
    address: string;
    minDb: number;
    maxDb: number;
    steps: number;
    refDb: number;
}

// The mic preamp gain the wizard starts each mic at, and the reference.
export const MIC_GAIN_DB = 20;

export const preampGain = (input: number): GainControl => ({
    address: `/headamp/${String(input).padStart(2, '0')}/gain`,
    minDb: GAIN_MIN_DB,
    maxDb: GAIN_MAX_DB,
    steps: GAIN_STEPS,
    refDb: MIC_GAIN_DB,
});

// Return trim (/ch/NN/preamp/rtntrim): -18..+18 dB, 145 steps.
export const returnTrim = (path: string): GainControl => ({
    address: `${path}/preamp/rtntrim`,
    minDb: -18,
    maxDb: 18,
    steps: 145,
    refDb: 0,
});

// A channel's gain control from its input source (config/insrc: 0..15 =
// In01..In16) and whether it uses its USB return (preamp/rtnsw), or null
// (aux or off input: no preamp).
export function channelGain(
    path: string,
    insrc: number | undefined,
    rtnsw: number | undefined
): GainControl | null {
    if (rtnsw === 1) return returnTrim(path);
    if (insrc !== undefined && insrc >= 0 && insrc < 16)
        return preampGain(insrc + 1);
    return null;
}

// A linear gain in dB to the X-Air float and back, on its steps.
export function gainDbToLevel(db: number, c: GainControl): number {
    const d = Math.min(c.maxDb, Math.max(c.minDb, db));
    const f = (d - c.minDb) / (c.maxDb - c.minDb);
    return Math.round(f * (c.steps - 1)) / (c.steps - 1);
}

export const gainLevelToDb = (f: number, c: GainControl) =>
    c.minDb + f * (c.maxDb - c.minDb);

// The size of one step of a gain control, dB.
export const gainStepDb = (c: GainControl) =>
    (c.maxDb - c.minDb) / (c.steps - 1);

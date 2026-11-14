/* eslint-disable max-classes-per-file */
// The level wizard's maths (levelWizard.ts runs it against the mixer).
//
// The room (Master / LR) is set by ear in the wizard and never judged: the
// venue's input may be line or mic level, XLR or 3.5 mm, so an LR dBFS says
// nothing about how loud the room is. Nothing here reads the LR fader. The
// stream mix is worked out from what the X-Air meters heard:
//  - each source's input level while it sounded (input meter, pre-fader,
//    with the wizard's preamp gain)
//  - its Bus 1 send so every source is equally loud on Bus 1
//  - the Bus 1 master so the stream sits at -14 LUFS with true peaks under
//    -1 dBTP (levelChange() in loudness.ts, the stream loudness check's own
//    maths)
// The X-Air meters are dBFS, not LUFS. A source's level here is the energy
// mean of its meter readings while it was over GATE_DB. Where the stream
// (vMix Bus A) was measured in LUFS at the same time, the difference between
// the two gives the meter-to-LUFS offset; without one the plan is an
// estimate until the stream is measured.

import { dbToLevel, FADER_STEPS, LEVEL_STEPS, levelToDb, MAX_DB } from './xair';
import { gatedLoudness, levelChange } from './loudness';
import { TALK_DB } from './talking';

export type SourceId = 'red' | 'blue' | 'match';

// A source is sounding when its input meter is over this (the talking
// detector's threshold).
export const GATE_DB = TALK_DB;

// Sounding time a step needs before it is done.
export const MIC_SECONDS = 5;
export const MATCH_SECONDS = 2;

// A step with nothing over GATE_DB for this long shows "No signal".
export const NO_SIGNAL_MS = 8000;

// A gap between meter packets longer than this is not counted as sounding
// time (packets come about every 50 ms).
const MAX_PACKET_GAP_MS = 200;

// Send taps that follow the channel fader: POST (4) and GRP (5).
export const followsFader = (tap: number | undefined) =>
    tap !== undefined && tap >= 4;

// GRP: the source goes to the bus at the fader level; its send level is
// not used.
export const isGroupTap = (tap: number | undefined) => tap === 5;

const power = (db: number) => 10 ** (db / 10);
const fromPower = (p: number) => 10 * Math.log10(p);

// Energy mean of dB values.
export function powerMean(dbs: number[]): number | null {
    const xs = dbs.filter((x) => Number.isFinite(x));
    if (!xs.length) return null;
    return fromPower(xs.reduce((s, x) => s + power(x), 0) / xs.length);
}

// One source's input meter over a step.
export class SourceMeter {
    private sum = 0;

    private n = 0;

    private lastT: number | null = null;

    public peakDb = -Infinity;

    public seconds = 0;

    public lastHeardAt: number | null = null;

    // One meter packet at time t (ms).
    public feed(t: number, inputDb: number) {
        const prev = this.lastT;
        this.lastT = t;
        if (!(inputDb >= GATE_DB)) return;
        this.sum += power(inputDb);
        this.n += 1;
        this.peakDb = Math.max(this.peakDb, inputDb);
        this.lastHeardAt = t;
        if (prev !== null)
            this.seconds += Math.min(t - prev, MAX_PACKET_GAP_MS) / 1000;
    }

    // Energy mean of the input while sounding, dBFS; null if never.
    public get inputDb(): number | null {
        return this.n ? fromPower(this.sum / this.n) : null;
    }
}

// The stream's 400 ms loudness blocks while one source sounded alone.
export class StreamMeter {
    public blocks: number[] = [];

    public peak = -Infinity;

    public add(m: number, peak: number | null) {
        this.blocks.push(m);
        if (peak !== null) this.peak = Math.max(this.peak, peak);
    }

    public get seconds() {
        return this.blocks.length / 10;
    }

    // Gated loudness of the blocks (BS.1770), LUFS.
    public get lufs(): number | null {
        return this.blocks.length ? gatedLoudness(this.blocks) : null;
    }
}

export type StepStatus =
    | 'listening'
    | 'done'
    | 'no signal'
    | 'no match'
    | 'match running';

// Where a step stands. Mic steps: done after MIC_SECONDS of talking; "no
// signal" when nothing was heard for NO_SIGNAL_MS. Match sounds: waiting for
// a match, listening while one runs, then done (or no signal) once it ends
// or the operator moves on.
export function stepStatus(
    id: SourceId,
    meter: { seconds: number; lastHeardAt: number | null },
    now: number,
    startedAt: number,
    match: { running: boolean; seen: boolean }
): StepStatus {
    if (id === 'match') {
        if (match.running) return 'match running';
        if (!match.seen)
            return meter.seconds >= MATCH_SECONDS ? 'done' : 'no match';
        return meter.seconds >= MATCH_SECONDS ? 'done' : 'no signal';
    }
    if (meter.seconds >= MIC_SECONDS) return 'done';
    const since = meter.lastHeardAt ?? startedAt;
    return now - since > NO_SIGNAL_MS ? 'no signal' : 'listening';
}

// What a step stored about one source.
export interface Measured {
    id: SourceId;
    // Energy mean and highest input meter reading while sounding, dBFS.
    inputDb: number;
    peakDb: number;
    // Stream loudness (vMix Bus A, LUFS) while it sounded alone, and the
    // stream bus level the meters gave at that moment, for the offset.
    streamLufs: number | null;
    meterBusDb: number | null;
}

// A source as the mixer holds it now.
export interface SourceMix {
    id: SourceId;
    faderDb: number;
    sendDb: number;
    tap?: number;
    // Muted or no send address: left out of the stream plan.
    usable: boolean;
}

// The level a source puts on the stream bus (before the bus master).
export function busLevel(inputDb: number, mix: SourceMix): number {
    if (isGroupTap(mix.tap)) return inputDb + mix.faderDb;
    return inputDb + mix.sendDb + (followsFader(mix.tap) ? mix.faderDb : 0);
}

// Meter dBFS to LUFS: the mean difference over the steps where the stream
// was measured, or null.
export function meterOffset(measured: Measured[]): number | null {
    const d = measured
        .filter((m) => m.streamLufs !== null && m.meterBusDb !== null)
        .map((m) => m.streamLufs! - m.meterBusDb!);
    return d.length ? d.reduce((s, x) => s + x, 0) / d.length : null;
}

export interface SendPlan {
    id: SourceId;
    fromDb: number;
    toDb: number;
    // The send could not reach the level the others are at: +10 dB max, or
    // a GRP tap (its send level is not used).
    limited: 'max' | 'grp' | null;
}

export interface StreamPlan {
    sends: SendPlan[];
    bus: { fromDb: number; toDb: number };
    // Each source's predicted stream loudness after the plan, LUFS (meter
    // dBFS where there is no offset).
    predicted: { id: SourceId; lufs: number }[];
    // Predicted stream loudness while someone talks, and highest peak.
    lufs: number;
    peakDb: number;
    // No LUFS measurement behind the offset: meter dBFS taken as LUFS.
    estimate: boolean;
    // The bus master stopped short of -14 LUFS: peaks or +10 dB.
    limitedBy: 'peak' | 'max' | null;
}

const quantize = (db: number, steps: number) => levelToDb(dbToLevel(db, steps));

// The stream mix from the stored levels: Bus 1 sends so all sources are
// equally loud on Bus 1, then the Bus 1 master so the stream reaches
// -14 LUFS without peaking. Sends are centred on 0 dB (the mean source
// level is the reference) and pulled down together when one would go over
// +10 dB. A GRP-tapped source cannot be moved by its send, so its level is
// the reference.
export function planStreamMix(
    measured: Measured[],
    mixes: SourceMix[],
    busFaderDb: number
): StreamPlan | null {
    const rows = measured
        .map((m) => ({ m, mix: mixes.find((x) => x.id === m.id) }))
        .filter(
            (r): r is { m: Measured; mix: SourceMix } => !!r.mix && r.mix.usable
        );
    if (!rows.length) return null;
    // Level into the send (0 dB send) of each source.
    const pre = (r: (typeof rows)[number]) =>
        r.m.inputDb + (followsFader(r.mix.tap) ? r.mix.faderDb : 0);
    const grp = rows.filter((r) => isGroupTap(r.mix.tap));
    const free = rows.filter((r) => !isGroupTap(r.mix.tap));
    let ref: number;
    if (grp.length)
        ref = powerMean(grp.map((r) => r.m.inputDb + r.mix.faderDb))!;
    else {
        ref = free.reduce((s, r) => s + pre(r), 0) / free.length;
        const most = Math.max(...free.map((r) => ref - pre(r)));
        if (most > MAX_DB) ref -= most - MAX_DB;
    }
    const sends: SendPlan[] = rows.map((r) => {
        if (isGroupTap(r.mix.tap))
            return {
                id: r.m.id,
                fromDb: r.mix.sendDb,
                toDb: r.mix.sendDb,
                limited: grp.length > 1 ? 'grp' : null,
            };
        const want = ref - pre(r);
        const toDb = quantize(Math.min(want, MAX_DB), LEVEL_STEPS);
        return {
            id: r.m.id,
            fromDb: r.mix.sendDb,
            toDb,
            limited: want > MAX_DB + 0.25 ? 'max' : null,
        };
    });
    const after = rows.map((r, k) => {
        const mix = { ...r.mix, sendDb: sends[k].toDb };
        return {
            id: r.m.id,
            level: busLevel(r.m.inputDb, mix),
            peak: busLevel(r.m.peakDb, mix),
        };
    });
    const offset = meterOffset(measured);
    const toLufs = offset ?? 0;
    // Talking is what the -14 LUFS reference is about: the mics, or every
    // source when no mic was measured.
    const mics = after.filter((a) => a.id !== 'match');
    const talk = powerMean((mics.length ? mics : after).map((a) => a.level))!;
    const peakIn = Math.max(...after.map((a) => a.peak));
    // The stream as it would be with the current bus master, then the
    // change that brings it to -14 LUFS under -1 dBTP.
    const change = levelChange(talk + toLufs + busFaderDb, peakIn + busFaderDb);
    let toDb = busFaderDb + (change.db ?? 0);
    let limitedBy: StreamPlan['limitedBy'] = null;
    if (toDb > MAX_DB) {
        toDb = MAX_DB;
        limitedBy = 'max';
    }
    toDb = quantize(toDb, FADER_STEPS);
    // Quantizing rounds to the nearest step; never past the peak limit.
    if (peakIn + toDb > -1 && toDb > -90)
        toDb = quantize(toDb - 0.1, FADER_STEPS);
    const lufs = talk + toLufs + toDb;
    if (!limitedBy && lufs < -14 - 0.5 && peakIn + toDb > -1.5)
        limitedBy = 'peak';
    return {
        sends,
        bus: { fromDb: busFaderDb, toDb },
        predicted: after.map((a) => ({
            id: a.id,
            lufs: a.level + toLufs + toDb,
        })),
        lufs,
        peakDb: peakIn + toDb,
        estimate: offset === null,
        limitedBy,
    };
}

// The change to the Bus 1 master that the real stream measurement asks for
// (the residual after the plan). No cap on the size: the limits are the
// physical ones, the true peak staying under -1 dBTP (levelChange) and the
// fader's +10 dB (dbToLevel).
export function residual(
    lufs: number | null,
    peak: number | null
): number | null {
    return levelChange(lufs, Number.isFinite(peak ?? NaN) ? peak : null).db;
}

import { EventEmitter } from 'events';
import log from 'electron-log';
import Checks, { MixerSource, MixerState } from './engine';
import AutoAV from '../addons/autoav';
import HWPing from '../addons/hw-ping';
import VmixService from '../../services/VmixService';
import { listMatches } from '../recordings/matchStore';
import {
    dbToLevel,
    FADER_STEPS,
    LEVEL_STEPS,
    levelToDb,
    METER_BUS,
    METER_LR_L,
    METER_LR_R,
    queryXair,
    setXair,
    writeXair,
    XairWrite,
} from './xair';
import {
    busLevel,
    GATE_DB,
    Measured,
    planStreamMix,
    powerMean,
    residual,
    SourceId,
    SourceMeter,
    SourceMix,
    StepStatus,
    stepStatus,
    StreamMeter,
    StreamPlan,
} from './levels';
import LiveLoudness, { LiveBlock } from './liveLoudness';
import { streamVerdict } from './loudness';
import {
    GainControl,
    gainDbToLevel,
    gainLevelToDb,
    gainStepDb,
    MIC_GAIN_DB,
} from '../../utils/xairLaw';
import { MatchRecord } from '../../models/MatchRecord';
import { MIN_TALK_SECONDS } from './talking';
import {
    LevelState,
    LevelStep,
    LEVEL_STEPS_ORDER,
    WizardState,
} from '../../models/Levels';

// The level wizard on the vMix / X-Air tab, and the tab's always-on audio
// meters.
//
// Steps, one source at a time:
//  1. Red mic (X-Air ch 1): preamp +20 dB, fader 0 dB, Master (LR) down to
//     -50 dB; the on-screen fader is Master, raised by ear in the room.
//  2. Blue mic (ch 2): preamp +20 dB, fader 0 dB; the on-screen control is
//     ch 2's preamp gain, by ear, the fader staying at 0 dB.
//  3. Match sounds: a match is run; the on-screen control is the
//     match-sound source's fader (the aux return "vMix PC": vMix's Master
//     comes into the X-Air there, see readMixer() in engine.ts). Filip:
//     nothing on the vMix side that feeds it is ever changed, and the aux
//     return is not balanced by gain, so this fader may end away from 0 dB.
//  4. DJ: the DJ channels' faders go to 0 dB with their preamp gain taking
//     the difference (the room stays as it was), then the on-screen control
//     is the DJ preamp gain, by ear. DJ music is copyrighted and never goes
//     to the stream: the DJ Bus 1 sends are turned off when the step opens
//     and again on Apply, and the stream plan leaves DJ out.
// Zero is balanced: at the end every fader but match sounds' is at 0 dB and
// the balance is in the input gains. A source with no gain control (input
// not a preamp) falls back to its fader and shows "No gain".
// Input meters are after the gain, so every level the wizard measures is
// taken back to the source's reference gain (the talking gate is meant at
// +20 dB on a mic) and forward again to the gain it has now.
//  5. Stream: the Bus 1 sends and master from the stored levels
//     (levels.ts), vMix Bus A to 0 dB, one Apply.
//  6. Check: the real stream loudness while someone talks, and the residual
//     to -14 LUFS, which "Stream level" puts on the Bus 1 master.
// Each step meters its source while it sounds alone. Every value the wizard
// changes is read first: Undo steps back one change, Cancel puts back what
// the mixer and vMix held when the wizard opened.

const STEP_LABEL: Record<SourceId | 'dj', string> = {
    red: 'Red mic',
    blue: 'Blue mic',
    match: 'Match sounds',
    dj: 'DJ',
};

// The fader every source but match sounds ends at: zero is balanced, the
// balance lives in the input gain. (Mic gain starts at MIC_GAIN_DB.)
const MIC_FADER_DB = 0;
const MASTER_START_DB = -50;

// A source must sound alone this long before a stream loudness block
// counts (the block is 400 ms, plus the capture's delay).
const ISOLATED_MS = 600;

// Talking is held this long past the last mic packet over the gate.
const TALK_HOLD_MS = 1000;

// Stream louder than this while DJ plays alone: DJ is on the stream.
const DJ_LEAK_LUFS = -50;

const METERS_STALE_MS = 2000;

const pad2 = (n: number) => String(n).padStart(2, '0');

type Kind = SourceId | 'dj';

interface UndoEntry {
    label: string;
    writes: XairWrite[];
    busAVolume?: number;
}

const finite = (x: number | null | undefined) =>
    x !== null && x !== undefined && Number.isFinite(x) ? x : null;

const mixerHost = (): string | null => HWPing.Instance.mixerAddress();

const readMixerState = (): MixerState | null => {
    const m = Checks.Instance.mixerState();
    return m?.reachable ? m : null;
};

// A source's input meter (the louder side of a stereo one).
const inputOf = (s: MixerSource, levels: number[]): number => {
    const l = levels[s.meter] ?? -Infinity;
    return s.stereo ? Math.max(l, levels[s.meter + 1] ?? -Infinity) : l;
};

// The X-Air sources of a step: the mics are channels 1 and 2, match sounds
// and DJ the sources readMixer() found by name.
const sources = (kind: Kind): MixerSource[] => {
    const m = readMixerState();
    if (!m) return [];
    if (kind === 'red') return m.mics.slice(0, 1);
    if (kind === 'blue') return m.mics.slice(1, 2);
    if (kind === 'match') return m.game;
    return m.dj;
};

// The stream bus's send number ("01") and master fader address.
const sendPad = () => pad2(readMixerState()?.streamBus ?? 1);

const busFaderAddr = () => `/bus/${readMixerState()?.streamBus ?? 1}/mix/fader`;

// A step's input level: the loudest of its sources.
const kindInput = (kind: Kind, levels: number[]): number => {
    const xs = sources(kind).map((s) => inputOf(s, levels));
    return xs.length ? Math.max(...xs) : -Infinity;
};

// DJ never back on the stream: Undo and Cancel leave a DJ Bus 1 send
// (level and "to group") off.
const neverDjOnStream = (ws: XairWrite[]): XairWrite[] => {
    const pad = sendPad();
    const dj = new Set(
        sources('dj').flatMap((s) => [
            `${s.path}/mix/${pad}/level`,
            `${s.path}/mix/${pad}/grpon`,
        ])
    );
    return ws.filter((w) => !dj.has(w.address) || w.value === 0);
};

// Master (the LR fader) is the operator's. The wizard writes it only for the
// red mic step's -50 dB start, from the on-screen fader the operator moves,
// and when Undo or Cancel put back a value it had. Every other write path
// goes through send() without `lr`, which refuses it.
export const LR_FADER = '/lr/mix/fader';

export type LrWrite = 'preset' | 'operator' | 'restore';

// Bus send tap: POST (4), after the channel fader.
export const POST_TAP = 4;

// Two mixer values are the same parameter step (the X-Air sends float32).
const sameValue = (a: number, b: number) => Math.abs(a - b) < 1e-5;

// What the on-screen control moves in a step: a fader (fader law) or an
// input gain (linear dB on its steps), on one or more addresses.
interface Control {
    label: string;
    kind: 'fader' | 'gain';
    addrs: string[];
    gain?: GainControl;
}

const controlToLevel = (c: Control, db: number) =>
    c.kind === 'gain' && c.gain
        ? gainDbToLevel(db, c.gain)
        : dbToLevel(db, FADER_STEPS);

const controlToDb = (c: Control, f: number) =>
    c.kind === 'gain' && c.gain ? gainLevelToDb(f, c.gain) : levelToDb(f);

export default class LevelWizard extends EventEmitter {
    private static instance: LevelWizard;

    private watching = false;

    private open = false;

    private step: LevelStep = 'red';

    private stepStartedAt = 0;

    // Steps whose setup (gain, fader, Master) has been done this session.
    private setUp = new Set<LevelStep>();

    private meters = new Map<string, SourceMeter>();

    private streams = new Map<Kind, StreamMeter>();

    // Meter level on Bus 1 (dBFS, with the bus master) at each accepted
    // stream block, per source: the meter side of the LUFS offset.
    private meterBus = new Map<Kind, number[]>();

    private verify = new StreamMeter();

    private lastBreak = 0;

    private lastMicAt = 0;

    // The current source's input readings of the last ISOLATED_MS.
    private recent: { t: number; db: number }[] = [];

    private matchSeen = false;

    private matchRunning: string | null = null;

    private levels: number[] = [];

    private levelsAt = 0;

    // Every parameter the wizard may write, as the mixer held it at open
    // (float, or int for grpon), and as it holds it now.
    private original = new Map<string, number>();

    private values = new Map<string, number>();

    private ints = new Set<string>();

    private busAOriginal: number | null = null;

    private busAVolume: number | null = null;

    private undo: UndoEntry[] = [];

    // The undo entry of the on-screen fader in this step, once it moved.
    private dragEntry: UndoEntry | null = null;

    private dragTimer: ReturnType<typeof setTimeout> | null = null;

    private dragPending: number | null = null;

    private plan: StreamPlan | null = null;

    // When the stream mix (or a Stream level) was last written.
    private appliedAt: number | null = null;

    private matchRecs: MatchRecord[] = [];

    private matchesAt = 0;

    private djSendOff = false;

    // Sources whose Bus 1 send tap Apply switched to POST.
    private madePost: SourceId[] = [];

    private busy = false;

    private error: string | null = null;

    private live = new LiveLoudness();

    private lastStreamM: number | null = null;

    private timer: ReturnType<typeof setInterval> | null = null;

    private vmixTimer: ReturnType<typeof setInterval> | null = null;

    // What the wizard itself last wrote to each parameter. A parameter whose
    // value has moved off this since (the desk, X-Air Edit, Companion) is
    // the operator's again: Undo and Cancel leave it where they put it.
    private written = new Map<string, number>();

    // A parameter pushed by the mixer (/xremote): faders, sends, taps and
    // the Bus 1 master moved anywhere show here at once, and the stream
    // plan follows them.
    private onParam = (address: string, value: string | number) => {
        if (!this.open || !this.values.has(address)) return;
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        const mine = this.written.get(address);
        this.values.set(address, v);
        if (mine !== undefined && sameValue(v, mine)) return;
        this.written.delete(address);
        if (this.step === 'stream') this.makePlan();
    };

    private stillOurs(address: string) {
        const w = this.written.get(address);
        const v = this.values.get(address);
        return w !== undefined && v !== undefined && sameValue(v, w);
    }

    private onMeters = (levels: number[], at: number) =>
        this.meterPacket(levels, at);

    private onPlay = () => {
        const m = AutoAV.Instance.matchInPlay(true);
        this.matchRunning = m?.label ?? null;
        if (m && this.open && this.step === 'match') this.matchSeen = true;
    };

    // #region lifecycle

    // The tab is showing: meters on, state pushed ~10 times a second.
    public watch(on: boolean) {
        this.watching = on;
        this.update();
    }

    private update() {
        const want = this.watching || this.open;
        Checks.Instance.wantMeters('levels', want);
        if (want && !this.timer) {
            Checks.Instance.on('meters', this.onMeters);
            Checks.Instance.on('mixer-param', this.onParam);
            AutoAV.Instance.on('play', this.onPlay);
            this.timer = setInterval(() => this.publish(), 100);
        } else if (!want && this.timer) {
            Checks.Instance.off('meters', this.onMeters);
            Checks.Instance.off('mixer-param', this.onParam);
            AutoAV.Instance.off('play', this.onPlay);
            clearInterval(this.timer);
            this.timer = null;
        }
        this.publish();
    }

    // The match-sound source that sounded most this session (the fader the
    // step moves and the one planned), else the first one readMixer found.
    private matchSource(): MixerSource | null {
        const game = sources('match');
        let best = game[0] ?? null;
        let most = 0;
        game.forEach((s) => {
            const sec = this.meters.get(s.path)?.seconds ?? 0;
            if (sec > most) {
                most = sec;
                best = s;
            }
        });
        return best;
    }

    public async start(): Promise<void> {
        const host = mixerHost();
        const m = readMixerState();
        if (!host || !m) throw new Error('X-Air not answering');
        if (!m.mics.length) throw new Error('No mic channels');
        this.reset();
        await this.readOriginal(host, m);
        this.open = true;
        this.live.onBlock = (b) => this.streamBlock(b);
        this.live.start();
        this.vmixTimer = setInterval(() => {
            this.readBusA().catch(() => undefined);
        }, 2000);
        this.update();
        await this.enter('red');
    }

    private reset() {
        this.setUp.clear();
        this.meters.clear();
        this.streams.clear();
        this.meterBus.clear();
        this.verify = new StreamMeter();
        this.undo = [];
        this.dragEntry = null;
        this.plan = null;
        this.appliedAt = null;
        this.djSendOff = false;
        this.madePost = [];
        this.matchSeen = false;
        this.error = null;
        this.original.clear();
        this.values.clear();
        this.written.clear();
        this.ints.clear();
    }

    // Read every parameter the wizard may write.
    private async readOriginal(host: string, m: MixerState) {
        const pad = sendPad();
        const withGain = [...m.mics.slice(0, 2), ...m.dj].filter((s) => s.gain);
        const addrs = [
            LR_FADER,
            busFaderAddr(),
            ...[...m.mics.slice(0, 2), ...m.game, ...m.dj].flatMap((s) => [
                `${s.path}/mix/fader`,
                `${s.path}/mix/${pad}/level`,
            ]),
            ...m.dj.map((s) => `${s.path}/mix/${pad}/grpon`),
            ...[...m.mics.slice(0, 2), ...m.game].map(
                (s) => `${s.path}/mix/${pad}/tap`
            ),
            ...withGain.map((s) => s.gain!.address),
        ];
        m.dj.forEach((s) => this.ints.add(`${s.path}/mix/${pad}/grpon`));
        [...m.mics.slice(0, 2), ...m.game].forEach((s) =>
            this.ints.add(`${s.path}/mix/${pad}/tap`)
        );
        const got = await queryXair(host, addrs);
        got.forEach((v, a) => {
            this.original.set(a, Number(v));
            this.values.set(a, Number(v));
        });
        await this.readBusA();
        this.busAOriginal = this.busAVolume;
    }

    // A source's gain setting now (dB), or undefined when it has none or
    // the mixer did not answer for it.
    private gainNow(s: MixerSource): number | undefined {
        if (!s.gain) return undefined;
        const f = this.values.get(s.gain.address);
        return f === undefined ? undefined : gainLevelToDb(f, s.gain);
    }

    // The source's gain control, when it has one the wizard can set.
    private gainOf(s: MixerSource | undefined): GainControl | undefined {
        return s && this.gainNow(s) !== undefined ? s.gain : undefined;
    }

    // An input meter reading taken back to the source's reference gain.
    private atRef(s: MixerSource, meterDb: number): number {
        const g = this.gainNow(s);
        return g === undefined || !s.gain
            ? meterDb
            : meterDb - (g - s.gain.refDb);
    }

    // A level at the reference gain brought to the gain the source has now.
    private atGainNow(s: MixerSource, refDb: number): number {
        const g = this.gainNow(s);
        return g === undefined || !s.gain ? refDb : refDb + (g - s.gain.refDb);
    }

    // A step's level at reference gain: the loudest of its sources.
    private kindRef(kind: Kind, levels: number[]): number {
        const xs = sources(kind).map((s) => this.atRef(s, inputOf(s, levels)));
        return xs.length ? Math.max(...xs) : -Infinity;
    }

    private async readBusA() {
        const v = await VmixService.Instance.GetBase()
            .then((p) => p?.vmix ?? null)
            .catch(() => null);
        const vol = Number(v?.audio?.busA?.volume);
        this.busAVolume = v?.audio?.busA && Number.isFinite(vol) ? vol : null;
    }

    public close(restore: boolean): Promise<void> {
        const done = async () => {
            if (restore) await this.restoreOriginal();
            this.open = false;
            this.live.stop();
            this.live.onBlock = null;
            if (this.vmixTimer) clearInterval(this.vmixTimer);
            this.vmixTimer = null;
            this.update();
        };
        return this.run(done);
    }

    // #endregion

    // #region steps

    public go(step: LevelStep): Promise<void> {
        return this.run(() => this.enter(step));
    }

    private async enter(step: LevelStep) {
        this.flushDrag();
        this.dragEntry = null;
        this.step = step;
        this.stepStartedAt = Date.now();
        this.recent = [];
        this.lastBreak = Date.now();
        if (step === 'match') this.matchSeen = !!this.matchRunning;
        if (step === 'stream') this.makePlan();
        if (step === 'check') this.verify = new StreamMeter();
        if (this.setUp.has(step)) return;
        this.setUp.add(step);
        const writes: XairWrite[] = [];
        if (step === 'red' || step === 'blue') {
            const s = sources(step)[0];
            const g = this.gainOf(s);
            if (g)
                writes.push({
                    address: g.address,
                    value: gainDbToLevel(MIC_GAIN_DB, g),
                });
            if (s)
                writes.push({
                    address: `${s.path}/mix/fader`,
                    value: dbToLevel(MIC_FADER_DB, FADER_STEPS),
                });
            if (step === 'red')
                writes.push({
                    address: LR_FADER,
                    value: dbToLevel(MASTER_START_DB, FADER_STEPS),
                });
        }
        if (step === 'dj') writes.push(...this.djOffWrites(), ...this.djZero());
        if (writes.length)
            await this.write(
                STEP_LABEL[step as Kind] ?? step,
                writes,
                undefined,
                step === 'red' ? 'preset' : undefined
            );
        if (step === 'dj' && writes.length) this.djSendOff = true;
    }

    // DJ never on the stream: every DJ Bus 1 send off, and "to group" off.
    private djOffWrites(): XairWrite[] {
        const pad = sendPad();
        const out: XairWrite[] = [];
        sources('dj').forEach((s) => {
            const lvl = `${s.path}/mix/${pad}/level`;
            const grp = `${s.path}/mix/${pad}/grpon`;
            if ((this.values.get(lvl) ?? 0) > 0)
                out.push({ address: lvl, value: 0 });
            if ((this.values.get(grp) ?? 0) !== 0)
                out.push({ address: grp, value: 0, int: true });
        });
        return out;
    }

    // DJ faders to 0 dB, the preamp gain taking the difference so the room
    // stays as loud as it was (clamped to the gain's range; a fader that was
    // off starts the gain at its lowest). A DJ channel without a gain the
    // wizard can set keeps its fader.
    private djZero(): XairWrite[] {
        const out: XairWrite[] = [];
        sources('dj').forEach((s) => {
            const g = this.gainOf(s);
            const fa = `${s.path}/mix/fader`;
            const f = this.values.get(fa);
            if (!g || f === undefined) return;
            const faderDb = levelToDb(f);
            const gainDb = this.gainNow(s)!;
            const want = Number.isFinite(faderDb)
                ? gainDb + faderDb - MIC_FADER_DB
                : g.minDb;
            out.push({ address: g.address, value: gainDbToLevel(want, g) });
            out.push({
                address: fa,
                value: dbToLevel(MIC_FADER_DB, FADER_STEPS),
            });
        });
        return out;
    }

    // What the on-screen control moves in this step.
    private control(): Control | null {
        const fader = (label: string, ss: MixerSource[]): Control | null =>
            ss.length
                ? {
                      label,
                      kind: 'fader',
                      addrs: ss.map((s) => `${s.path}/mix/fader`),
                  }
                : null;
        const gain = (label: string, ss: MixerSource[]): Control | null => {
            const gs = ss.map((s) => this.gainOf(s));
            if (!ss.length || gs.some((g) => !g)) return null;
            return {
                label,
                kind: 'gain',
                addrs: gs.map((g) => g!.address),
                gain: gs[0],
            };
        };
        switch (this.step) {
            case 'red':
                return { label: 'Master', kind: 'fader', addrs: [LR_FADER] };
            case 'blue':
                return (
                    gain('Blue mic gain', sources('blue')) ??
                    fader('Blue mic', sources('blue'))
                );
            case 'match': {
                const s = this.matchSource();
                return s ? fader('Match sounds', [s]) : null;
            }
            case 'dj':
                return (
                    gain('DJ gain', sources('dj')) ?? fader('DJ', sources('dj'))
                );
            default:
                return null;
        }
    }

    private faderAddrs(): string[] {
        return this.control()?.addrs ?? [];
    }

    // The on-screen control moved (dB, fader or gain). Writes go out at most
    // every 40 ms; the first move of a step is one undo entry for the whole
    // drag.
    public fader(db: number) {
        const addrs = this.faderAddrs();
        const host = mixerHost();
        // -Infinity is the fader at the bottom (off).
        if (!addrs.length || !host || Number.isNaN(db) || db === Infinity)
            return;
        if (!this.dragEntry) {
            this.dragEntry = {
                label: this.control()?.label ?? 'Fader',
                writes: addrs.map((a) => ({
                    address: a,
                    value: this.values.get(a) ?? 0,
                })),
            };
            this.undo.push(this.dragEntry);
        }
        this.dragPending = db;
        if (this.dragTimer) return;
        this.dragTimer = setTimeout(() => {
            this.dragTimer = null;
            this.flushDrag();
        }, 40);
    }

    private flushDrag() {
        const db = this.dragPending;
        this.dragPending = null;
        const host = mixerHost();
        const c = this.control();
        if (db === null || !host || !c) return;
        const value = controlToLevel(c, db);
        // The operator's own control (the only live write of Master).
        const writes = c.addrs.map((a) => ({ address: a, value }));
        writes.forEach((w) => {
            this.values.set(w.address, w.value);
            this.written.set(w.address, w.value);
        });
        writeXair(host, writes).catch(() => undefined);
    }

    // The fader was let go: read back what the mixer holds.
    public faderDone(): Promise<void> {
        return this.run(async () => {
            if (this.dragTimer) clearTimeout(this.dragTimer);
            this.dragTimer = null;
            this.flushDrag();
            const host = mixerHost();
            if (!host) return;
            const got = await queryXair(host, this.faderAddrs());
            got.forEach((v, a) => this.values.set(a, Number(v)));
            await Checks.Instance.refresh();
        });
    }

    // #endregion

    // #region writes

    // Write a group of parameters as one undo entry (the values they had),
    // then read them back.
    private async write(
        label: string,
        writes: XairWrite[],
        busAVolume?: number,
        lr?: LrWrite
    ) {
        const host = mixerHost();
        if (!host) throw new Error('X-Air not answering');
        const entry: UndoEntry = {
            label,
            writes: writes.map((w) => ({
                address: w.address,
                value: this.values.get(w.address) ?? 0,
                int: w.int,
            })),
        };
        if (busAVolume !== undefined && this.busAVolume !== null)
            entry.busAVolume = this.busAVolume;
        this.undo.push(entry);
        // Refused before anything is written or kept for undo.
        if (!lr && writes.some((w) => w.address === LR_FADER)) {
            this.undo.pop();
            throw new Error('Master is not automatic');
        }
        log.info(`levels: ${label}`, writes);
        await this.send(host, writes, lr);
        if (busAVolume !== undefined) await this.setBusA(busAVolume);
    }

    private async send(host: string, writes: XairWrite[], lr?: LrWrite) {
        if (!lr && writes.some((w) => w.address === LR_FADER))
            throw new Error('Master is not automatic');
        if (!writes.length) return;
        const got = await setXair(host, writes);
        writes.forEach((w) => {
            const v = got.get(w.address);
            if (v === undefined) throw new Error('X-Air did not confirm');
            this.values.set(w.address, Number(v));
            this.written.set(w.address, Number(v));
        });
        await Checks.Instance.refresh();
    }

    private async setBusA(volume: number) {
        await VmixService.Instance.Function('SetBusAVolume', {
            Value: String(volume),
        });
        await this.readBusA();
    }

    public undoLast(): Promise<void> {
        return this.run(async () => {
            this.flushDrag();
            const e = this.undo.pop();
            if (!e) return;
            if (e === this.dragEntry) this.dragEntry = null;
            const host = mixerHost();
            if (!host) throw new Error('X-Air not answering');
            // Not over a value the operator has set since.
            const back = e.writes.filter((w) => this.stillOurs(w.address));
            log.info(`levels: undo ${e.label}`, back);
            await this.send(host, neverDjOnStream(back), 'restore');
            if (e.busAVolume !== undefined) await this.setBusA(e.busAVolume);
            if (this.step === 'stream') this.makePlan();
        });
    }

    private async restoreOriginal() {
        this.flushDrag();
        const host = mixerHost();
        if (!host || !this.undo.length) return;
        // Only what the wizard changed goes back.
        const touched = new Set(
            this.undo.flatMap((e) => e.writes.map((w) => w.address))
        );
        // Only values still as the wizard left them: a fader the operator
        // moved on the desk since stays where they put it.
        const writes = [...touched]
            .filter((a) => this.original.has(a) && this.stillOurs(a))
            .map((a) => ({
                address: a,
                value: this.original.get(a)!,
                int: this.ints.has(a),
            }));
        log.info('levels: cancel, restore', writes);
        await this.send(host, neverDjOnStream(writes), 'restore');
        if (
            this.undo.some((e) => e.busAVolume !== undefined) &&
            this.busAOriginal !== null
        )
            await this.setBusA(this.busAOriginal);
        this.undo = [];
    }

    // One action at a time; an error is shown, not thrown at the UI.
    private async run(fn: () => Promise<void>) {
        this.busy = true;
        this.error = null;
        this.publish();
        try {
            await fn();
        } catch (e) {
            log.warn('levels: failed', e);
            this.error = (e as Error).message;
        }
        this.busy = false;
        this.publish();
    }

    // #endregion

    // #region measuring

    private meterPacket(levels: number[], at: number) {
        this.levels = levels;
        this.levelsAt = at;
        if (!this.open) return;
        const kinds: Kind[] = ['red', 'blue', 'match', 'dj'];
        // Sounding: over the gate at the source's reference gain.
        const active = new Map(
            kinds.map((k) => [k, this.kindRef(k, levels) >= GATE_DB])
        );
        if (active.get('red') || active.get('blue')) this.lastMicAt = at;
        const cur = this.step as Kind;
        if (!kinds.includes(cur)) return;
        sources(cur).forEach((s) => {
            const key = s.path;
            if (!this.meters.has(key)) this.meters.set(key, new SourceMeter());
            this.meters.get(key)!.feed(at, this.atRef(s, inputOf(s, levels)));
        });
        const alone =
            active.get(cur) && kinds.every((k) => k === cur || !active.get(k));
        if (!alone) this.lastBreak = at;
        this.recent.push({ t: at, db: kindInput(cur, levels) });
        while (this.recent.length && this.recent[0].t < at - ISOLATED_MS)
            this.recent.shift();
    }

    // A stream loudness block (vMix Bus A).
    private streamBlock(b: LiveBlock) {
        this.lastStreamM = b.m;
        if (!this.open) return;
        if (this.step === 'check') {
            if (b.at - this.lastMicAt <= TALK_HOLD_MS)
                this.verify.add(b.m, b.peak);
            return;
        }
        const cur = this.step as Kind;
        if (!['red', 'blue', 'match', 'dj'].includes(cur)) return;
        if (b.at - this.lastBreak < ISOLATED_MS) return;
        // Only with vMix Bus A at 0 dB (volume 100) does the stream level
        // say what Bus 1 sends; DJ is checked at any Bus A level.
        if (cur !== 'dj' && this.busAVolume !== 100) return;
        if (!this.streams.has(cur)) this.streams.set(cur, new StreamMeter());
        this.streams.get(cur)!.add(b.m, b.peak);
        if (cur === 'dj') return;
        const input = powerMean(this.recent.map((r) => r.db));
        const mix = this.mixOf(cur);
        const busFader = levelToDb(this.values.get(busFaderAddr()) ?? 0);
        if (input !== null && mix) {
            const lvl = busLevel(input, mix) + busFader;
            if (!this.meterBus.has(cur)) this.meterBus.set(cur, []);
            this.meterBus.get(cur)!.push(lvl);
        }
    }

    // A source's fader and send as the mixer holds them now.
    private mixOf(kind: SourceId): SourceMix | null {
        const s = kind === 'match' ? this.matchSource() : sources(kind)[0];
        if (!s) return null;
        const pad = sendPad();
        const fader = this.values.get(`${s.path}/mix/fader`);
        const send = this.values.get(`${s.path}/mix/${pad}/level`);
        const tap = this.values.get(`${s.path}/mix/${pad}/tap`);
        return {
            id: kind,
            faderDb: levelToDb(fader ?? 0),
            sendDb: levelToDb(send ?? 0),
            tap: tap ?? s.streamTap,
            usable: s.on !== false && send !== undefined && fader !== undefined,
        };
    }

    private measuredOf(kind: SourceId): Measured | null {
        const s = kind === 'match' ? this.matchSource() : sources(kind)[0];
        const meter = s ? this.meters.get(s.path) : undefined;
        const ref = meter?.inputDb ?? null;
        if (!s || !meter || ref === null || meter.seconds < 1) return null;
        const lufs = this.streams.get(kind)?.lufs ?? null;
        // Measured at reference gain; on the mixer at the gain it has now.
        return {
            id: kind,
            inputDb: this.atGainNow(s, ref),
            peakDb: this.atGainNow(s, meter.peakDb),
            streamLufs: lufs,
            meterBusDb:
                lufs !== null ? powerMean(this.meterBus.get(kind) ?? []) : null,
        };
    }

    // The mic and match-sound Bus 1 sends whose tap is not POST: Apply
    // switches them, so the stream follows a channel fader the operator
    // rides for the room (a new announcer on a mic). Never DJ.
    private notPost(): { id: SourceId; address: string }[] {
        const pad = sendPad();
        const out: { id: SourceId; address: string }[] = [];
        (['red', 'blue', 'match'] as SourceId[]).forEach((k) => {
            const s = k === 'match' ? this.matchSource() : sources(k)[0];
            if (!s) return;
            const address = `${s.path}/mix/${pad}/tap`;
            const tap = this.values.get(address) ?? s.streamTap;
            if (tap !== undefined && tap !== POST_TAP)
                out.push({ id: k, address });
        });
        return out;
    }

    // The plan is for the sends as Apply leaves them: post-fader.
    private makePlan() {
        const ids: SourceId[] = ['red', 'blue', 'match'];
        const measured = ids
            .map((k) => this.measuredOf(k))
            .filter((x): x is Measured => !!x);
        const mixes = ids
            .map((k) => this.mixOf(k))
            .filter((x): x is SourceMix => !!x)
            .map((x) => ({ ...x, tap: POST_TAP }));
        const bus = levelToDb(this.values.get(busFaderAddr()) ?? 0);
        this.plan = planStreamMix(measured, mixes, bus);
    }

    // Apply the stream plan: Bus 1 sends, Bus 1 master, DJ sends off,
    // vMix Bus A to 0 dB (volume 100).
    public apply(): Promise<void> {
        return this.run(async () => {
            this.makePlan();
            const p = this.plan;
            if (!p) throw new Error('Nothing measured');
            const pad = sendPad();
            const toPost = this.notPost();
            const writes: XairWrite[] = toPost.map((t) => ({
                address: t.address,
                value: POST_TAP,
                int: true,
            }));
            p.sends.forEach((sp) => {
                const s =
                    sp.id === 'match' ? this.matchSource() : sources(sp.id)[0];
                if (!s || sp.limited === 'grp') return;
                writes.push({
                    address: `${s.path}/mix/${pad}/level`,
                    value: dbToLevel(sp.toDb, LEVEL_STEPS),
                });
            });
            writes.push({
                address: busFaderAddr(),
                value: dbToLevel(p.bus.toDb, FADER_STEPS),
            });
            writes.push(...this.djOffWrites());
            await this.write(
                'Stream mix',
                writes,
                this.busAVolume !== 100 ? 100 : undefined
            );
            this.appliedAt = Date.now();
            this.madePost = toPost.map((t) => t.id);
            await this.enter('check');
        });
    }

    // The residual the real stream measurement asks for, onto the Bus 1
    // master.
    public streamLevel(): Promise<void> {
        return this.run(async () => {
            const v = this.verifyResult();
            if (v.residual === null) throw new Error('No stream measurement');
            const addr = busFaderAddr();
            const now = levelToDb(this.values.get(addr) ?? 0);
            await this.write(
                'Stream level',
                [
                    {
                        address: addr,
                        value: dbToLevel(now + v.residual, FADER_STEPS),
                    },
                ],
                this.busAVolume !== 100 ? 100 : undefined
            );
            this.appliedAt = Date.now();
            this.verify = new StreamMeter();
        });
    }

    // The stream measured after Apply: live (talking blocks on Bus A), else
    // the newest match video measured since (the stream loudness check).
    private verifyResult(): WizardState['verify'] {
        if (this.verify.seconds >= MIN_TALK_SECONDS) {
            const { lufs } = this.verify;
            const peak = finite(this.verify.peak);
            return {
                from: 'live',
                lufs,
                peak,
                seconds: this.verify.seconds,
                residual: residual(lufs, peak),
                state: streamVerdict(lufs, peak)?.state ?? null,
            };
        }
        const since = this.appliedAt;
        if (since) {
            // The manifest is on disk: read at most every 5 s.
            if (Date.now() - this.matchesAt > 5000) {
                this.matchesAt = Date.now();
                this.matchRecs = listMatches(
                    AutoAV.Instance.getStatus().saveFolder
                );
            }
            const rec = this.matchRecs.find(
                (r) => r.startedAt >= since && r.loudness?.talk?.lufs != null
            );
            if (rec?.loudness?.talk) {
                const { lufs } = rec.loudness.talk;
                const peak = finite(rec.loudness.truePeak);
                return {
                    from: 'match',
                    lufs,
                    peak,
                    seconds: rec.loudness.talk.seconds,
                    residual: residual(lufs, peak),
                    state: streamVerdict(lufs, peak)?.state ?? null,
                };
            }
        }
        return {
            from: null,
            lufs: null,
            peak: null,
            seconds: this.verify.seconds,
            residual: null,
            state: null,
        };
    }

    // #endregion

    // #region state

    private stepStatusOf(kind: Kind): StepStatus {
        const ms = sources(kind).map((s) => this.meters.get(s.path));
        const best = ms.reduce<SourceMeter | undefined>(
            (b, x) => (x && (!b || x.seconds > b.seconds) ? x : b),
            undefined
        );
        return stepStatus(
            kind === 'dj' ? 'red' : kind,
            best ?? { seconds: 0, lastHeardAt: null },
            Date.now(),
            this.step === kind ? this.stepStartedAt : 0,
            { running: !!this.matchRunning, seen: this.matchSeen }
        );
    }

    public state(): LevelState {
        const fresh = Date.now() - this.levelsAt < METERS_STALE_MS;
        const l = fresh ? this.levels : [];
        const m = readMixerState();
        const bus = m?.streamBus ?? 1;
        const lr = Math.max(
            l[METER_LR_L] ?? -Infinity,
            l[METER_LR_R] ?? -Infinity
        );
        const busPre = l[METER_BUS + bus - 1];
        const busFader = m?.streamBusFaderDb;
        return {
            mixer: !!m,
            streamBus: bus,
            masterOut: finite(lr),
            streamOut:
                busPre !== undefined && busFader !== undefined
                    ? finite(busPre + busFader)
                    : null,
            wizard: this.open ? this.wizardState(l) : null,
        };
    }

    private wizardState(l: number[]): WizardState {
        const kind = this.step as Kind;
        const isSource = ['red', 'blue', 'match', 'dj'].includes(kind);
        const c = this.control();
        const cv = c ? this.values.get(c.addrs[0]) : undefined;
        const busDb = levelToDb(this.values.get(busFaderAddr()) ?? 0);
        const rows = (['red', 'blue', 'match', 'dj'] as Kind[]).map((k) => {
            const meas = k === 'dj' ? null : this.measuredOf(k);
            const djMeter = sources('dj')
                .map((s) => {
                    const r = this.meters.get(s.path)?.inputDb ?? null;
                    return r === null ? null : this.atGainNow(s, r);
                })
                .filter((x): x is number => x !== null);
            const src = k === 'match' ? this.matchSource() : sources(k)[0];
            let input = meas?.inputDb ?? null;
            if (k === 'dj')
                input = djMeter.length ? Math.max(...djMeter) : null;
            const mix = k === 'dj' ? null : this.mixOf(k);
            const planned =
                this.plan?.predicted.find((x) => x.id === k)?.lufs ?? null;
            const send = this.plan?.sends.find((x) => x.id === k);
            return {
                id: k,
                label: STEP_LABEL[k],
                status: this.stepStatusOf(k),
                input: finite(input),
                gain: src ? finite(this.gainNow(src)) : null,
                // On Bus 1 out: as planned when there is a plan, else now.
                bus:
                    input !== null && mix
                        ? finite(
                              busLevel(
                                  input,
                                  send
                                      ? {
                                            ...mix,
                                            sendDb: send.toDb,
                                            tap: POST_TAP,
                                        }
                                      : mix
                              ) + (this.plan ? this.plan.bus.toDb : busDb)
                          )
                        : null,
                stream: k === 'dj' ? null : finite(planned),
                sendLimited: send?.limited ?? null,
            };
        });
        const dj = this.streams.get('dj')?.lufs ?? null;
        const v = this.verifyResult();
        return {
            step: this.step,
            steps: LEVEL_STEPS_ORDER,
            input: isSource ? finite(kindInput(kind, l)) : null,
            control:
                c && cv !== undefined
                    ? {
                          label: c.label,
                          kind: c.kind,
                          db: controlToDb(c, cv),
                          minDb: c.gain?.minDb ?? null,
                          maxDb: c.gain?.maxDb ?? null,
                          stepDb: c.gain ? gainStepDb(c.gain) : null,
                      }
                    : null,
            matchRunning: this.matchRunning,
            // Mics and DJ with no gain the wizard can set.
            noGain: (['red', 'blue', 'dj'] as const).filter((k) =>
                sources(k).some((s) => !this.gainOf(s))
            ),
            djSendOff: this.djSendOff,
            toPost: this.open ? this.notPost().map((t) => t.id) : [],
            madePost: this.madePost,
            djOnStream: dj !== null && dj > DJ_LEAK_LUFS,
            rows,
            plan: this.plan
                ? {
                      busFrom: this.plan.bus.fromDb,
                      busTo: this.plan.bus.toDb,
                      lufs: this.plan.lufs,
                      peak: this.plan.peakDb,
                      estimate: this.plan.estimate,
                      limitedBy: this.plan.limitedBy,
                  }
                : null,
            busAVolume: this.busAVolume,
            stream: {
                running: this.live.running,
                failed: this.live.failed,
                momentary:
                    this.live.lastAt && Date.now() - this.live.lastAt < 1000
                        ? finite(this.lastStreamM)
                        : null,
            },
            verify: v,
            applied: this.appliedAt !== null,
            undo: this.undo.length,
            busy: this.busy,
            error: this.error,
        };
    }

    private publish() {
        this.emit('state', this.state());
    }

    // #endregion

    public static get Instance(): LevelWizard {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}

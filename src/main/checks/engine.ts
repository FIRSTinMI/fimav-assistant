import { EventEmitter } from 'events';
import log from 'electron-log';
import VmixService from '../../services/VmixService';
import AutoAV from '../addons/autoav';
import LiveCaptions from '../addons/live-captions';
import AudienceDisplayAddon from '../addons/audience-display';
import YoutubeUploaderAddon from '../addons/upload-helper';
import HWPing from '../addons/hw-ping';
import getVmixBandwidth, { streamKeyFromUrl } from '../vmixBandwidth';
import { listMatches } from '../recordings/matchStore';
import { getStore } from '../store';
import { levelToDb, queryXair, XairMeters } from './xair';
import { channelGain, GainControl, gainLevelToDb } from '../../utils/xairLaw';
import XairWatch from './xairWatch';
import { MIN_TALK_SECONDS, TALK_DB, talkLog } from './talking';
import { streamVerdict } from './loudness';
import VmixEvents from './vmixEvents';
import {
    readStreamSettings,
    VmixStreamSettings,
    watchStreamSettings,
} from './vmixSettings';
import {
    fetchAndParseAudioDevices,
    isXairOut,
    setDefaultAudioDevice,
    setVolumePercent,
    unmuteDevice,
} from '../events/HWCheck';
import { ParsedSoundOutput } from '../../models/SoundVolumeViewOutput';
import {
    CaptionPushStatus,
    enableCaptionPush,
    keyFromCaptionUrl,
    setCaptionKey,
} from './captionsYoutube';
import { CheckResult, CheckState, isAlerting } from '../../models/Checks';
import { MatchRecord } from '../../models/MatchRecord';

// Stream and audio checks for a live event. Every check reads state the cart
// already has (the vMix API, vMix's stream logs, the X-Air over OSC, FMS or
// FTC Live match state, the match manifest) and nothing records or decodes
// audio or video live. Each source is read once at start, then again only
// when it says it changed:
//  - vMix: TCP activators (8099); the API itself is polled only in the 4 s
//    match start sound window (meters, 500 ms)
//  - match state: FMS SignalR / FTC Live via AutoAV 'play'
//  - X-Air: /xremote pushes setting changes; meters pushed during a match
//    and while vMix records (the mic levels say when someone talks)
//  - vMix stream/recording settings: its autosave file changing
//  - hardware pings, Live Captions phase, match manifest: their own events
// Timers only where a source cannot push: stream logs every 5 s while
// streaming (a stall is no writes), live-captions' YouTube status (10 s
// streaming / 60 s otherwise), Windows audio devices (60 s), and the end
// of a grace delay or an Ignore. Loudness: one audio-only ffmpeg pass per
// finished match (loudness.ts).
// A check that is failing raises a banner and a Windows notification once;
// "Ignore" silences that one check for 6 h (kept in the store across restarts).

export type { CheckResult, CheckState } from '../../models/Checks';

const IGNORE_MS = 6 * 60 * 60 * 1000;

// Stream loudness while someone talks: YouTube turns anything over -14 LUFS
// down to it and never turns a quieter stream up. A change to make of up to
// 5 dB (after the headroom cap below) is fine; over that the warning gives
// the change, in dB.
// Peaks over -1 dBTP are "Peaking", and a boost is never more than the
// headroom left under -1 dBTP, so the advice never makes the stream peak.
// (The target, the peak limit, the change maths and the 5 dB tolerance:
// streamVerdict() in loudness.ts.)

// A send or fader at or under this is treated as off.
const OFF_DB = -40;

// Mics vs match sounds on the stream bus: only a big gap is reported.
const BALANCE_DB = 15;

type Def = Pick<CheckResult, 'id' | 'group' | 'label'> & {
    doc?: string;
    hint?: string;
};

const DOCS = 'https://docs.fimav.us/docs';

type Fix = { label: string; run: () => Promise<unknown> };

const vmixFn =
    (fn: string, params: Record<string, string> = {}): Fix['run'] =>
    () =>
        VmixService.Instance.Function(fn, params);

// "Live Captions updating" / "starting" while start() is on its way, else
// null. At app launch it checks for an update first, then waits for :3000.
const liveCaptionsWait = (): string | null => {
    const phase = LiveCaptions.Instance.getPhase();
    if (phase === 'updating') return 'Live Captions updating';
    if (phase === 'starting') return 'Live Captions starting';
    return null;
};

// The YouTube push status from live-captions' event stream (the last
// 'youtube' message, else the one in 'hello').
const captionPushFromEvents = (): CaptionPushStatus | null => {
    const { latest } = LiveCaptions.Instance.events;
    const yt = (latest.get('youtube') ?? latest.get('hello')?.youtube) as
        | CaptionPushStatus
        | undefined;
    return yt ?? null;
};

// The transcription engine's state from live-captions' event stream.
const captionEngine = (): { state: string; error: string | null } | null => {
    const { latest } = LiveCaptions.Instance.events;
    const e = (latest.get('engine') ?? latest.get('hello')?.engine) as
        | { state: string; error: string | null }
        | undefined;
    return e ?? null;
};

// The overlay channel FIM puts Live Captions on.
const CAPTIONS_OVERLAY = 8;

const DEFS: Def[] = [
    {
        id: 'hw-network',
        group: 'Hardware',
        label: 'Network',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/#1-check-internet-connection`,
    },
    {
        id: 'hw-ip',
        group: 'Hardware',
        label: 'IP config',
        doc: `${DOCS}/setting-up-the-fim-av-system/#check-network-configuration`,
    },
    { id: 'hw-switch', group: 'Hardware', label: 'Switch' },
    { id: 'hw-mixer', group: 'Hardware', label: 'Mixer' },
    { id: 'hw-camera1', group: 'Hardware', label: 'Camera 1' },
    { id: 'hw-camera2', group: 'Hardware', label: 'Camera 2' },
    {
        id: 'stream-match',
        group: 'Stream',
        label: 'Stream during match',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/`,
    },
    {
        id: 'stream-health',
        group: 'Stream',
        label: 'Stream health',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/#1-check-internet-connection`,
    },
    {
        id: 'stream-bus',
        group: 'Stream',
        label: 'Stream audio source',
        hint:
            'Bus A keeps the copyrighted DJ music out of the stream, which ' +
            'goes to YouTube.',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#3-check-stream-settings-in-vmix`,
    },
    {
        id: 'recording-match',
        group: 'Recording',
        label: 'Recording during match',
    },
    {
        id: 'recording-bus',
        group: 'Recording',
        label: 'Recording audio source',
        hint:
            'Bus A keeps the copyrighted DJ music out of the match ' +
            'recordings, which go to YouTube.',
        doc: `${DOCS}/setting-up-the-fim-av-system/#verify-stream`,
    },
    {
        id: 'uploader',
        group: 'Recording',
        label: 'YouTube uploads',
    },
    {
        id: 'stream-audio',
        group: 'Audio',
        label: 'Stream audio (Bus A)',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#4-check-levels-in-vmix`,
    },
    {
        id: 'stream-loudness',
        group: 'Audio',
        label: 'Stream loudness',
        doc: `${DOCS}/audio-volume/`,
    },
    {
        id: 'dj-stream',
        group: 'Audio',
        label: 'DJ on stream bus',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#1-test-using-game-sounds-or-a-microphone`,
    },
    {
        id: 'match-sounds',
        group: 'Audio',
        label: 'Match sounds',
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'windows-audio',
        group: 'Audio',
        label: 'Windows audio',
        hint:
            'Windows plays the match sounds through its default device; ' +
            "the X-Air's OUT 1-2 must be default, unmuted and at 100%.",
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'match-buzzer',
        group: 'Audio',
        label: 'Match start sound',
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'mic-balance',
        group: 'Audio',
        label: 'Mics vs match sounds',
        doc: `${DOCS}/audio-volume/#helpful-guide-to-implementing-and-auditing-yourself`,
    },
    {
        id: 'captions',
        group: 'Captions',
        label: 'Captions overlay',
        doc: `${DOCS}/software-guides/captions/#adding-the-captions-to-vmix`,
    },
    {
        id: 'captions-engine',
        group: 'Captions',
        label: 'Captions engine',
        doc: `${DOCS}/software-guides/captions/#the-captions-are-not-showing-up`,
    },
    {
        id: 'captions-youtube',
        group: 'Captions',
        label: 'YouTube captions',
        doc: `${DOCS}/software-guides/captions/#youtube-caption-push`,
    },
    {
        id: 'stream-output',
        group: 'Captions',
        label: 'Captions off stream',
        hint:
            'Output 1 and overlay 8 carry the venue captions. On the live ' +
            'stream or the match recordings they are baked into the video; ' +
            'YouTube gets its captions from Live Captions instead.',
        doc: `${DOCS}/software-guides/captions/#hiding-captions-from-streamrecording`,
    },
    {
        id: 'audience-display',
        group: 'Display',
        label: 'Custom audience display',
    },
];

const truthy = (v: unknown) =>
    String(
        typeof v === 'object' && v ? (v as any)['#text'] : v
    ).toLowerCase() === 'true';

const list = <T>(v: T | T[] | undefined): T[] => {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
};

// Linear vMix meter (0..1) to dB.
const meterDb = (v: unknown) => {
    const n = Number(v);
    return n > 0 ? 20 * Math.log10(n) : -Infinity;
};

export interface MixerSource {
    name: string;
    // OSC prefix: /ch/NN or /rtn/aux
    path: string;
    // Meter index in /meters/1 (left side for stereo)
    meter: number;
    // Stereo source: the meter after `meter` is its right side.
    stereo?: boolean;
    on?: boolean;
    faderDb?: number;
    lr?: boolean;
    streamSendDb?: number;
    // Tap of the stream bus send: 0 IN, 1 PREEQ, 2 POSTEQ, 3 PRE, 4 POST,
    // 5 GRP. POST and GRP follow the channel fader.
    streamTap?: number;
    // Its input gain (mic preamp or USB return trim) and setting, dB.
    gain?: GainControl;
    gainDb?: number;
}

// A source's input meter taken back to its reference gain (MIC_GAIN_DB for
// a mic preamp): the level the talking gate is meant at, whatever the gain
// is turned to. Unknown gain: the meter as it is.
export const atRefGain = (s: MixerSource, levelDb: number) =>
    s.gain && s.gainDb !== undefined
        ? levelDb - (s.gainDb - s.gain.refDb)
        : levelDb;

export interface MixerState {
    at: number;
    reachable: boolean;
    streamBus: number;
    streamBusName: string;
    // Stream bus master fader, dB. (The LR fader is not read: Master is the
    // operator's, set by ear, and nothing is worked out from it.)
    streamBusFaderDb?: number;
    dj: MixerSource[];
    game: MixerSource[];
    mics: MixerSource[];
}

function pad2(n: number) {
    return String(n).padStart(2, '0');
}

// Read names first, then the mix settings of the sources the checks care
// about. Sources are found by name, as FIM's scenes name them: the bus named
// "Stream" (else Bus 1), "DJ" channels (not "Stream DJ"), match sounds on the
// aux return (17+18, "vMix PC") or channels named vMix/FMS/Game, and the
// mics on channels 1 and 2.
async function readMixer(host: string): Promise<MixerState> {
    const names = [
        ...Array.from(
            { length: 16 },
            (_, i) => `/ch/${pad2(i + 1)}/config/name`
        ),
        '/rtn/aux/config/name',
        ...Array.from({ length: 6 }, (_, i) => `/bus/${i + 1}/config/name`),
    ];
    const got = await queryXair(host, names);
    const empty: MixerState = {
        at: Date.now(),
        reachable: false,
        streamBus: 1,
        streamBusName: 'Bus 1',
        dj: [],
        game: [],
        mics: [],
    };
    if (got.size === 0) return empty;

    const name = (a: string) => String(got.get(a) ?? '').trim();
    let streamBus = 1;
    for (let b = 1; b <= 6; b += 1) {
        if (/stream/i.test(name(`/bus/${b}/config/name`))) {
            streamBus = b;
            break;
        }
    }
    const channels: MixerSource[] = Array.from({ length: 16 }, (_, i) => ({
        name: name(`/ch/${pad2(i + 1)}/config/name`) || `Ch ${i + 1}`,
        path: `/ch/${pad2(i + 1)}`,
        meter: i,
    }));
    const aux: MixerSource = {
        name: name('/rtn/aux/config/name') || 'Aux (17+18)',
        path: '/rtn/aux',
        meter: 16,
        stereo: true,
    };
    const dj = channels.filter(
        (c) => /\bdj\b/i.test(c.name) && !/stream/i.test(c.name)
    );
    let game = channels.filter((c) => /vmix|vmic|fms|game/i.test(c.name));
    if (/vmix|fms|game|pc/i.test(aux.name) || game.length === 0)
        game = [aux, ...game];
    const mics = channels.slice(0, 2);

    const sources = [...dj, ...game, ...mics];
    const sendPad = pad2(streamBus);
    const isCh = (s: MixerSource) => s.path.startsWith('/ch/');
    const mixAddrs = sources.flatMap((s) => [
        `${s.path}/mix/on`,
        `${s.path}/mix/fader`,
        `${s.path}/mix/lr`,
        `${s.path}/mix/${sendPad}/level`,
        `${s.path}/mix/${sendPad}/tap`,
        // A channel's input, for its preamp gain.
        ...(isCh(s)
            ? [`${s.path}/config/insrc`, `${s.path}/preamp/rtnsw`]
            : []),
    ]);
    const busFader = `/bus/${streamBus}/mix/fader`;
    const mix = await queryXair(host, [...mixAddrs, busFader]);
    sources.forEach((s) => {
        const v = (k: string) => mix.get(`${s.path}/mix/${k}`);
        if (v('on') !== undefined) s.on = Number(v('on')) === 1;
        if (v('fader') !== undefined) s.faderDb = levelToDb(Number(v('fader')));
        if (v('lr') !== undefined) s.lr = Number(v('lr')) === 1;
        const send = v(`${sendPad}/level`);
        if (send !== undefined) s.streamSendDb = levelToDb(Number(send));
        const tap = v(`${sendPad}/tap`);
        if (tap !== undefined) s.streamTap = Number(tap);
        if (isCh(s)) {
            const num = (a: string) =>
                mix.has(a) ? Number(mix.get(a)) : undefined;
            s.gain =
                channelGain(
                    s.path,
                    num(`${s.path}/config/insrc`),
                    num(`${s.path}/preamp/rtnsw`)
                ) ?? undefined;
        }
    });
    // The gains themselves (the aux return has none).
    const withGain = sources.filter((s) => s.gain);
    const gains = withGain.length
        ? await queryXair(
              host,
              withGain.map((s) => s.gain!.address)
          )
        : new Map();
    withGain.forEach((s) => {
        const g = gains.get(s.gain!.address);
        if (g !== undefined) s.gainDb = gainLevelToDb(Number(g), s.gain!);
    });
    const fdr = (a: string) =>
        mix.has(a) ? levelToDb(Number(mix.get(a))) : undefined;
    return {
        at: Date.now(),
        reachable: true,
        streamBusFaderDb: fdr(busFader),
        streamBus,
        streamBusName:
            name(`/bus/${streamBus}/config/name`) || `Bus ${streamBus}`,
        dj,
        game,
        mics,
    };
}

// p-th percentile of a list (0..1), or null when empty.
function percentile(xs: number[], p: number): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// A dB change as a label: "+3.2 dB" / "\u22122.1 dB".
const dbChange = (db: number) =>
    `${db >= 0 ? '+' : '\u2212'}${Math.abs(db).toFixed(1)} dB`;

// The stream loudness verdict for one measured match video.
// Peaks are the whole video's true peak: a fader change moves every peak in
// it, talking or not. Loudness is the gated loudness while someone talked.
export function loudnessVerdict(
    loudness: NonNullable<MatchRecord['loudness']>
): { state: CheckState; detail: string } {
    const { talk } = loudness;
    const peak =
        loudness.truePeak !== null && Number.isFinite(loudness.truePeak)
            ? loudness.truePeak
            : null;
    const lufs = talk?.heard && talk.lufs !== null ? talk.lufs : null;
    const level = [
        lufs !== null ? `${lufs.toFixed(1)} LUFS` : null,
        peak !== null ? `peak ${peak.toFixed(1)} dBTP` : null,
    ]
        .filter(Boolean)
        .join(', ');
    const v = streamVerdict(lufs, peak);

    if (v?.peaking) {
        return {
            state: 'warning',
            detail: `Peaking, Stream audio ${dbChange(v.db!)} (${level})`,
        };
    }
    // No verdict on loudness without enough talking to judge.
    if (!talk?.heard) return { state: 'unknown', detail: 'No mic levels' };
    if (talk.seconds < MIN_TALK_SECONDS)
        return { state: 'unknown', detail: 'Not enough talking' };
    if (!v) return { state: 'warning', detail: 'No stream audio, mics live' };
    // Judged on the change shown (streamVerdict), not the gap to -14.
    if (v.state === 'warning')
        return {
            state: 'warning',
            detail: `${
                v.db! > 0 ? 'Too quiet' : 'Too loud'
            }, Stream audio ${dbChange(v.db!)} (${level})`,
        };
    return { state: 'ok', detail: level };
}

export default class Checks extends EventEmitter {
    private static instance: Checks;

    private results = new Map<string, CheckResult>();

    private timer: ReturnType<typeof setTimeout> | null = null;

    private since = new Map<string, number>();

    // held() ids evaluated this tick; any other is reset after the tick, so
    // a timer from a branch that stopped running does not carry over.
    private heldSeen = new Set<string>();

    // When each pending held() condition comes due (cleared every tick).
    private heldDue = new Map<string, number>();

    private fixes = new Map<string, Fix>();

    private settings: VmixStreamSettings | null = null;

    private captionPush: CaptionPushStatus | null = null;

    // The uploader's last quota / rate-limit error, from its event stream.
    private uploadQuota: string | null = null;

    // The custom audience display's standing error, from its event stream.
    private adError: string | null = null;

    // Windows' X-Air playback device, from SoundVolumeView; undefined until
    // the first read, null when it is not there.
    private winAudio: ParsedSoundOutput | null | undefined;

    private winAudioAt = 0;

    // Set by an event that says a source changed; that source is read again
    // on the next tick instead of on a timer.
    private dirty = { vmix: true, mixer: true, loudness: true };

    private vmixEvents = new VmixEvents();

    private mixerWatch = new XairWatch();

    private lastBalanceSample = 0;

    // Runs the loop now (set in start()).
    private kick: (() => void) | null = null;

    private notified = new Set<string>();

    private vmix: any = null;

    private bandwidthAt = 0;

    private bandwidth: Awaited<ReturnType<typeof getVmixBandwidth>> | null =
        null;

    private mixer: MixerState | null = null;

    private meters = new XairMeters();

    // Callers that want the X-Air meters running outside a match or a
    // recording (the vMix / X-Air tab's audio section, the level wizard).
    private meterDemand = new Set<string>();

    // The match in play at the last tick, to catch starts and ends.
    private lastMatch: string | null = null;

    // Match start sound: samples of the FMS input meter after a start.
    private buzzer: {
        label: string;
        until: number;
        peakDb: number;
        busPeakDb: number;
        streaming: boolean;
    } | null = null;

    // Set when the last match start sound reached the FMS input but not Bus
    // A (the stream); kept until the next match start.
    private busMissedStart: string | null = null;

    // Mics and match-sound levels on the stream bus during the current match.
    private balance: { label: string; mic: number[]; game: number[] } | null =
        null;

    public start() {
        DEFS.forEach((d) =>
            this.results.set(d.id, {
                ...d,
                state: 'unknown',
                detail: ['match-buzzer', 'mic-balance'].includes(d.id)
                    ? 'No match yet'
                    : '',
                doc: d.doc ?? null,
                hint: d.hint ?? null,
                ignoredUntil: null,
                fix: null,
            })
        );
        // One loop. Events (a match state change, vMix activators, X-Air
        // parameter changes, hardware, Live Captions) run it now rather than
        // at its next turn; mid-tick they make the next wait 0. Bursts within
        // 150 ms are one run.
        let inTick = false;
        let again = false;
        const loop = async () => {
            this.timer = null;
            inTick = true;
            try {
                await this.runTick();
            } catch (e) {
                log.warn('Checks tick failed', e);
            }
            inTick = false;
            const wait = again ? 0 : this.nextWait();
            again = false;
            // setTimeout cannot take Infinity (it would fire at once).
            this.timer = Number.isFinite(wait) ? setTimeout(loop, wait) : null;
        };
        this.kick = () => {
            if (inTick) {
                again = true;
                return;
            }
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(loop, 150);
        };
        const changed = (what?: keyof Checks['dirty']) => () => {
            if (what) this.dirty[what] = true;
            this.kick?.();
        };
        AutoAV.Instance.on('play', changed());
        AutoAV.Instance.on('match', changed('loudness'));
        AutoAV.Instance.on('matches', changed('loudness'));
        HWPing.Instance.on('hw-change', changed('mixer'));
        HWPing.Instance.on('ip-config-changed', changed());
        LiveCaptions.Instance.phase.on('phase', changed());
        LiveCaptions.Instance.events.on('message', changed());
        LiveCaptions.Instance.events.on('connection', changed());
        YoutubeUploaderAddon.Instance.phase.on('phase', changed());
        YoutubeUploaderAddon.Instance.events.on('message', (m) => {
            // A quota error stands until an upload goes through again.
            if (m.type === 'quota') this.uploadQuota = String(m.error ?? '');
            else if (m.type === 'upload' && m.status === 'done')
                this.uploadQuota = null;
            this.kick?.();
        });
        YoutubeUploaderAddon.Instance.events.on('connection', changed());
        AudienceDisplayAddon.Instance.phase.on('phase', changed());
        AudienceDisplayAddon.Instance.events.on('message', (m) => {
            // An error stands until FMS reconnects or the display restarts
            // (it re-sends standing errors right after 'hello').
            if (m.type === 'error') this.adError = String(m.message ?? '');
            else if (m.type === 'hello') this.adError = null;
            else if (m.type === 'fms' && m.connected) this.adError = null;
            this.kick?.();
        });
        AudienceDisplayAddon.Instance.events.on('connection', changed());
        this.vmixEvents.on('change', changed('vmix'));
        // Stream / recording settings send no activator; vMix's autosave
        // (about once a minute) does change.
        if (process.platform === 'win32') watchStreamSettings(changed());
        this.vmixEvents.start(VmixService.Instance.Host());
        this.mixerWatch.onChange = changed('mixer');
        // A parameter changed on the mixer (desk, X-Air Edit, Companion):
        // 'mixer-param' (address, value), for the level wizard.
        this.mixerWatch.onParam = (address, value) =>
            this.emit('mixer-param', address, value);
        this.meters.onData = () => {
            this.emit('meters', this.meters.latest, this.meters.lastAt);
            // Talking on the mics: every meter packet (about 50 ms).
            this.noteTalking();
            // Mic/match-sound balance: a sample per meter packet, at most
            // twice a second.
            const t = Date.now();
            if (t - this.lastBalanceSample < 500) return;
            this.lastBalanceSample = t;
            this.sampleBalance();
        };
        loop();
    }

    // Time to the next tick when no event comes first; Infinity is no timer.
    // Everything that can push (vMix activators, X-Air /xremote, match
    // state, hardware, Live Captions, the manifest, vMix's autosave file)
    // runs the loop itself. A timer is only for what cannot:
    //  - the start sound window (vMix meters, 500 ms for 4 s)
    //  - a held() delay coming due (e.g. 5 s into a match without stream)
    //  - stream logs while streaming (a stall is no writes: 5 s)
    //  - Windows audio devices (60 s; no push without a native module)
    //  - an Ignore running out
    private nextWait(): number {
        const now = Date.now();
        const waits: number[] = [];
        if (this.buzzer) waits.push(500);
        this.heldDue.forEach((due) => waits.push(due - now));
        const streaming = !!this.vmix && truthy(this.vmix.streaming);
        if (streaming) waits.push(5000);
        if (process.platform === 'win32')
            waits.push(this.winAudioAt + 60000 - now);
        this.results.forEach((r) => {
            if (r.ignoredUntil) waits.push(r.ignoredUntil - now);
        });
        return Math.max(0, Math.min(...waits));
    }

    // What the checks last read, for the status API. Stream keys stay out:
    // only whether one is set and whether the caption key matches it.
    public sources() {
        const st = this.settings;
        const d = this.winAudio;
        const m = this.mixer;
        const p = this.captionPush;
        const captionKey = keyFromCaptionUrl(p?.url ?? null);
        const src = (x: MixerSource) => ({
            name: x.name,
            on: x.on ?? null,
            faderDb: x.faderDb ?? null,
            mainMix: x.lr ?? null,
            streamSendDb: x.streamSendDb ?? null,
        });
        return {
            vmixEvents: this.vmixEvents.connected,
            vmixSettings: st
                ? {
                      streamAudioBus: st.audioBus,
                      streamOutput: st.output,
                      recorder1Output: st.recordOutput,
                      recorder1AudioBus: st.recordAudioBus,
                      output2Overlays: st.output2Overlays,
                      youtubeKeySet: !!st.youtubeKey,
                  }
                : null,
            windowsAudio:
                d === undefined
                    ? null
                    : {
                          xairFound: !!d,
                          default: d ? d.default === 'Render' : null,
                          muted: d ? d.muted : null,
                          volumePercent: d
                              ? parseInt(
                                    String(d.volume_percent).replace('%', ''),
                                    10
                                )
                              : null,
                      },
            mixer: m
                ? {
                      reachable: m.reachable,
                      streamBus: m.streamBus,
                      streamBusName: m.streamBusName,
                      dj: m.dj.map(src),
                      matchSounds: m.game.map(src),
                      mics: m.mics.map(src),
                      lastChangeAt: this.mixerWatch.lastAt || null,
                  }
                : null,
            uploader: {
                phase: YoutubeUploaderAddon.Instance.getPhase(),
                eventStream: YoutubeUploaderAddon.Instance.events.connected,
                signin:
                    YoutubeUploaderAddon.Instance.events.latest.get('signin') ??
                    YoutubeUploaderAddon.Instance.events.latest.get('hello')
                        ?.signin ??
                    null,
                queue:
                    YoutubeUploaderAddon.Instance.events.latest.get('queue') ??
                    YoutubeUploaderAddon.Instance.events.latest.get('hello')
                        ?.queue ??
                    null,
                watching:
                    YoutubeUploaderAddon.Instance.events.latest.get(
                        'watching'
                    ) ??
                    YoutubeUploaderAddon.Instance.events.latest.get('hello')
                        ?.watching ??
                    null,
                quotaError: this.uploadQuota,
            },
            audienceDisplay: {
                phase: AudienceDisplayAddon.Instance.getPhase(),
                eventStream: AudienceDisplayAddon.Instance.events.connected,
                profile:
                    AudienceDisplayAddon.Instance.events.latest.get(
                        'profile'
                    ) ??
                    AudienceDisplayAddon.Instance.events.latest.get('hello')
                        ?.profile ??
                    null,
                fms:
                    AudienceDisplayAddon.Instance.events.latest.get('fms') ??
                    AudienceDisplayAddon.Instance.events.latest.get('hello')
                        ?.fms ??
                    null,
                error: this.adError,
            },
            liveCaptions: {
                phase: LiveCaptions.Instance.getPhase(),
                eventStream: LiveCaptions.Instance.events.connected,
                engine: captionEngine(),
                inputs:
                    (LiveCaptions.Instance.events.latest.get('inputs')
                        ?.inputs as unknown) ??
                    LiveCaptions.Instance.events.latest.get('hello')?.inputs ??
                    null,
                youtube: p
                    ? {
                          enabled: p.enabled,
                          keySet: !!captionKey,
                          keyMatchesStream:
                              captionKey && st?.youtubeKey
                                  ? captionKey === st.youtubeKey
                                  : null,
                          lastPushAt: p.lastPushAt,
                          lastError: p.lastError,
                          queueDepth: p.queueDepth,
                      }
                    : null,
            },
        };
    }

    // The X-Air as last read, and its host; null before the first read.
    public mixerState(): MixerState | null {
        return this.mixer;
    }

    // vMix's API state as last read (null when it did not answer).
    public vmixState(): any {
        return this.vmix;
    }

    // Keep the X-Air meters running for `who` (on) or stop asking (off).
    // Meter packets are the 'meters' event: (levels: number[], at: number).
    public wantMeters(who: string, on: boolean) {
        if (on) this.meterDemand.add(who);
        else this.meterDemand.delete(who);
        this.kick?.();
    }

    // Read the X-Air and vMix again now (after the level wizard wrote).
    public async refresh(): Promise<void> {
        this.dirty.mixer = true;
        this.dirty.vmix = true;
        await this.runTick();
    }

    public list(): CheckResult[] {
        return DEFS.map((d) => this.results.get(d.id)!).filter(Boolean);
    }

    public ignore(id: string) {
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        ignored[id] = Date.now() + IGNORE_MS;
        getStore().set('checks.ignoredUntil', ignored);
        this.publish();
    }

    public unignore(id: string) {
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        delete ignored[id];
        getStore().set('checks.ignoredUntil', ignored);
        this.publish();
    }

    // True once `cond` has held for `ms`.
    private held(id: string, cond: boolean, ms: number): boolean {
        this.heldSeen.add(id);
        if (!cond) {
            this.since.delete(id);
            return false;
        }
        const t = this.since.get(id) ?? Date.now();
        this.since.set(id, t);
        const done = Date.now() - t >= ms;
        // Not yet: the loop wakes when it would be, rather than polling.
        if (!done) this.heldDue.set(id, t + ms);
        return done;
    }

    // `fix` is a one-click repair for this exact problem; any later set()
    // without one clears it.
    private set(id: string, state: CheckState, detail: string, fix?: Fix) {
        const r = this.results.get(id);
        if (!r) return;
        if (fix) this.fixes.set(id, fix);
        else this.fixes.delete(id);
        this.results.set(id, { ...r, state, detail, fix: fix?.label ?? null });
    }

    public async fix(id: string): Promise<void> {
        const f = this.fixes.get(id);
        if (!f) throw new Error('Nothing to fix');
        log.info(`checks: fix ${id}: ${f.label}`);
        await f.run();
        // Check again now, not on the next loop, so the result (and the
        // button) updates as soon as the fix is in.
        this.winAudioAt = 0;
        this.dirty = { vmix: true, mixer: true, loudness: true };
        await this.runTick();
    }

    // One tick at a time: a fix's re-check and the loop share this.
    private ticking: Promise<void> = Promise.resolve();

    private runTick(): Promise<void> {
        this.ticking = this.ticking
            .catch(() => undefined)
            .then(() => this.tick());
        return this.ticking;
    }

    private async tick() {
        const now = Date.now();
        this.heldSeen.clear();
        this.heldDue.clear();
        const match = AutoAV.Instance.matchInPlay();

        // vMix: read at start and when its TCP connection (re)opens or an
        // activator fires; polled only in the start sound window (meters).
        if (this.dirty.vmix || this.buzzer) {
            this.dirty.vmix = false;
            this.vmix = await VmixService.Instance.GetBase()
                .then((p) => p?.vmix ?? null)
                .catch(() => null);
        }
        const streamingNow = !!this.vmix && truthy(this.vmix.streaming);
        // Stream logs only while streaming: speed, stall and bus come from them.
        if (!streamingNow) this.bandwidth = null;
        else if (now - this.bandwidthAt >= 5000) {
            this.bandwidthAt = now;
            this.bandwidth = await getVmixBandwidth().catch(() => null);
        }
        // X-Air: read at start, on a pushed parameter change, and when its
        // ping comes back (hw-change), so a mixer powered on later is read.
        const host = HWPing.Instance.mixerAddress();
        if (host) this.mixerWatch.start(host);
        if (host && (this.dirty.mixer || !this.mixer)) {
            this.dirty.mixer = false;
            this.mixer = await readMixer(host).catch(() => null);
        }

        // Match start/end: buzzer window, balance.
        const label = match?.label ?? null;
        if (label !== this.lastMatch) {
            if (this.lastMatch) this.endMatch();
            if (label) this.beginMatch(label, host);
            this.lastMatch = label;
        }
        // X-Air meters while a match is on or vMix records: the balance
        // and the talking the stream loudness check is judged on.
        if (
            host &&
            this.mixer?.reachable &&
            (label ||
                (!!this.vmix && truthy(this.vmix.recording)) ||
                this.meterDemand.size > 0)
        )
            this.meters.start(host);
        else this.meters.stop();

        // One SoundVolumeView run a minute (it lists every audio device).
        if (process.platform === 'win32' && now - this.winAudioAt >= 60000) {
            this.winAudioAt = now;
            // An empty list means SoundVolumeView did not answer (every
            // Windows machine has some audio device): no verdict.
            this.winAudio = await fetchAndParseAudioDevices(log)
                .then((ds) =>
                    ds.length ? ds.find(isXairOut) ?? null : undefined
                )
                .catch(() => undefined);
        }
        // vMix's autosave; only re-read when vMix has rewritten it.
        // With vMix closed the file holds the last session's settings, which
        // may not be what vMix opens next: only read it while vMix answers.
        this.settings = this.vmix ? readStreamSettings() : null;
        // live-captions' YouTube status, from its event stream.
        this.captionPush = LiveCaptions.Instance.events.connected
            ? captionPushFromEvents()
            : null;

        const v = this.vmix;
        const streaming = !!v && truthy(v.streaming);
        const recording = !!v && truthy(v.recording);
        this.checkHardware();
        this.checkStream(v, match, streaming);
        this.checkStreamBus(v, streaming);
        this.checkStreamOutput();
        this.checkRecordingBus();
        this.checkRecording(v, match, recording);
        this.checkStreamAudio(v, match, streaming);
        this.checkLoudness();
        this.checkMixer();
        this.checkMatchSounds(v);
        this.checkWindowsAudio();
        this.checkBuzzer(v);
        this.checkCaptions(v);
        this.checkCaptionsEngine();
        this.checkAudienceDisplay();
        this.checkUploader();
        this.checkCaptionsYoutube(streaming);
        [...this.since.keys()].forEach((id) => {
            if (!this.heldSeen.has(id)) this.since.delete(id);
        });
        this.publish();
    }

    // #region checks

    private checkStream(
        v: any,
        match: { label: string } | null,
        streaming: boolean
    ) {
        if (!v) {
            this.set('stream-match', 'unknown', 'vMix not answering');
            this.set('stream-health', 'unknown', 'vMix not answering');
            return;
        }
        if (this.held('stream-match', !!match && !streaming, 5000)) {
            this.set(
                'stream-match',
                'critical',
                `${match!.label} running, not streaming`,
                { label: 'Start stream', run: vmixFn('StartStreaming') }
            );
        } else if (!match) {
            // Between matches there is nothing to check.
            this.set('stream-match', 'unknown', 'No match');
        } else if (streaming) {
            this.set('stream-match', 'ok', 'Streaming');
        } else {
            this.set('stream-match', 'ok', `${match.label} starting`);
        }

        if (!streaming) {
            this.held('stream-stall', false, 0);
            this.set('stream-health', 'unknown', 'Not streaming');
            return;
        }
        const bw = this.bandwidth;
        if (!bw || !bw.supported || bw.warming) {
            this.set('stream-health', 'unknown', 'No stream data yet');
            return;
        }

        // getVmixBandwidth lists only streams whose log grew since its last
        // read, so a stalled stream drops out of the list.
        const live = bw.streams;
        const kbps = live.reduce((t, s) => t + (s.liveKbps ?? 0), 0);
        // Stalled: no stream log growing (vMix's ffmpeg stopped writing), or
        // every stream running under real time. Bitrate is not used: the
        // stream is variable bitrate, so a static scene is legitimately low.
        const stalled =
            live.length === 0 ||
            live.every((s) => s.speed !== null && s.speed < 0.9);
        const mbps = (k: number) => (k / 1000).toFixed(1);
        if (this.held('stream-stall', stalled, 20000)) {
            this.set(
                'stream-health',
                'critical',
                live.length
                    ? `Stalled: ${Math.min(
                          ...live.map((x) => x.speed ?? 1)
                      ).toFixed(2)}x real time`
                    : 'Stalled: no data going out'
            );
        } else {
            this.set(
                'stream-health',
                'ok',
                `${live.length} stream${live.length === 1 ? '' : 's'}, ${mbps(
                    kbps
                )} Mbps`
            );
        }
    }

    // The status bar's hardware pings (hw-ping.ts, every 10 s) and its
    // network interface check (every 60 s), shown here as checks.
    private checkHardware() {
        const hw = HWPing.Instance;
        const st = hw.currentStatus;
        const pinged = hw.lastPingAt > 0;
        const dev = (id: string, alive: boolean, state: CheckState) => {
            if (!pinged) this.set(id, 'unknown', 'Not pinged yet');
            else if (alive) this.set(id, 'ok', 'Online');
            else this.set(id, state, 'No reply');
        };
        dev('hw-network', st.internet, 'critical');
        dev('hw-switch', st.switch, 'warning');
        dev('hw-mixer', st.mixer, 'warning');
        dev('hw-camera1', st.camera1, 'warning');
        dev('hw-camera2', st.camera2, 'warning');
        // hw-ping's messages end in advice ("... Check cable or DHCP.");
        // the first clause is the finding.
        const first = (msgs: string[]) =>
            msgs[0].split('. ')[0].replace(/\.$/, '') +
            (msgs.length > 1 ? ` (+${msgs.length - 1})` : '');
        if (st.ip_errors.length)
            this.set('hw-ip', 'critical', first(st.ip_errors));
        else if (st.ip_warnings.length)
            this.set('hw-ip', 'warning', first(st.ip_warnings));
        else this.set('hw-ip', 'ok', 'Expected ranges');
    }

    // Two sources. While live, the audio device each stream's ffmpeg reads,
    // from its log's command line: the stream as it runs. Always, the stream
    // settings in vMix's autosave, so a wrong bus shows before going live.
    // Bus A is the mix without the DJ music: the stream goes to YouTube, so
    // anything else risks copyrighted music on it.
    private checkStreamBus(v: any, streaming: boolean) {
        if (!v) {
            this.set('stream-bus', 'unknown', 'vMix not answering');
            return;
        }
        const setting = this.settings?.audioBus ?? null;
        const live = streaming
            ? (this.bandwidth?.streams ?? []).filter((s) => s.audioBus)
            : [];
        const wrong = live.filter((s) => s.audioBus !== 'Bus A');
        if (wrong.length) {
            this.set(
                'stream-bus',
                'critical',
                wrong
                    .map((s) => `Stream ${s.index} on ${s.audioBus}, not Bus A`)
                    .join(', ')
            );
        } else if (setting && setting !== 'Bus A') {
            // Live on Bus A but changed in settings: the next start is wrong.
            this.set(
                'stream-bus',
                live.length ? 'warning' : 'critical',
                `Stream settings on ${setting}, not Bus A`
            );
        } else if (live.length) {
            this.set(
                'stream-bus',
                'ok',
                live.map((s) => `Stream ${s.index} on Bus A`).join(', ')
            );
        } else if (setting) {
            this.set('stream-bus', 'ok', 'Stream settings on Bus A');
        } else if (!streaming) {
            this.set('stream-bus', 'unknown', 'No vMix settings file');
        }
        // Live with no stream data (stalled or first read): keep the last.
    }

    // FIM streams and records (recorder 1) Output 2, and Output 2 leaves
    // out overlay 8 (Live Captions, which go to YouTube as real captions,
    // not burned in).
    private checkStreamOutput() {
        const st = this.settings;
        if (!this.vmix) {
            this.set('stream-output', 'unknown', 'vMix not answering');
            return;
        }
        if (!st || st.output === null) {
            this.set('stream-output', 'unknown', 'No vMix settings file');
            return;
        }
        const problems: string[] = [];
        if (st.output !== 2)
            problems.push(`Stream on Output ${st.output}, not Output 2`);
        if (st.recordOutput !== null && st.recordOutput !== 2)
            problems.push(
                `Recorder 1 on Output ${st.recordOutput}, not Output 2`
            );
        if (st.output2Overlays?.includes(CAPTIONS_OVERLAY))
            problems.push(`Overlay ${CAPTIONS_OVERLAY} (captions) on Output 2`);
        if (problems.length)
            this.set('stream-output', 'warning', problems.join(', '));
        else
            this.set(
                'stream-output',
                'ok',
                `Stream and recorder 1 on Output 2, no overlay ${CAPTIONS_OVERLAY}`
            );
    }

    // Recorder 1's audio, from vMix's autosave: Bus A, as for the stream.
    private checkRecordingBus() {
        const bus = this.settings?.recordAudioBus ?? null;
        if (!this.vmix)
            this.set('recording-bus', 'unknown', 'vMix not answering');
        else if (!bus)
            this.set('recording-bus', 'unknown', 'No vMix settings file');
        else if (bus !== 'Bus A')
            this.set(
                'recording-bus',
                'warning',
                `Recorder 1 on ${bus}, not Bus A`
            );
        else this.set('recording-bus', 'ok', 'Recorder 1 on Bus A');
    }

    private checkRecording(
        v: any,
        match: { label: string } | null,
        recording: boolean
    ) {
        if (!v) {
            this.set('recording-match', 'unknown', 'vMix not answering');
            return;
        }
        if (this.held('recording-match', !!match && !recording, 10000)) {
            this.set(
                'recording-match',
                'warning',
                `${match!.label} running, not recording`
            );
        } else if (!match) {
            this.set('recording-match', 'unknown', 'No match');
        } else {
            this.set('recording-match', 'ok', 'Recording');
        }
    }

    private checkStreamAudio(
        v: any,
        match: { label: string } | null,
        streaming: boolean
    ) {
        const bus = v?.audio?.busA;
        if (!v) {
            this.set('stream-audio', 'unknown', 'vMix not answering');
            return;
        }
        // FIM streams and records Bus A. With no Bus A set up in vMix's
        // audio mixer, the stream has no audio at all.
        if (!bus) {
            this.set(
                'stream-audio',
                'critical',
                'No Bus A in vMix audio mixer'
            );
            return;
        }
        const db = Math.max(meterDb(bus.meterF1), meterDb(bus.meterF2));
        const live = streaming && !!match;
        const unmute: Fix = {
            label: 'Unmute',
            run: vmixFn('BusXAudioOn', { Value: 'A' }),
        };
        // The missed start sound clears once the display input and Bus A
        // sound together again (routing fixed), not only at the next match.
        const input = this.displayInput(v);
        const inputDb = input
            ? Math.max(meterDb(input.meterF1), meterDb(input.meterF2))
            : -Infinity;
        if (this.busMissedStart && !this.buzzer && inputDb >= -50 && db >= -50)
            this.busMissedStart = null;
        if (truthy(bus.muted)) {
            // Muted before going live is a warning: the stream (and the
            // recordings, also on Bus A) would start silent.
            this.set(
                'stream-audio',
                live ? 'critical' : 'warning',
                'Bus A muted',
                unmute
            );
        } else if (!streaming) {
            this.set('stream-audio', 'unknown', 'Not streaming');
        } else if (this.busMissedStart) {
            this.set('stream-audio', 'critical', this.busMissedStart);
        } else {
            // No level here: vMix is not polled for meters outside the
            // start sound window.
            this.set('stream-audio', 'ok', 'Bus A on');
        }
    }

    private checkLoudness() {
        // The manifest is read from disk: only when AutoAV says a match
        // record changed (a loudness result is written into it).
        if (!this.dirty.loudness) return;
        this.dirty.loudness = false;
        const folder = AutoAV.Instance.getStatus().saveFolder;
        const rec = listMatches(folder).find((m) => m.loudness);
        if (!rec?.loudness) {
            this.set('stream-loudness', 'unknown', 'No measurement yet');
            return;
        }
        const name = rec.ftc?.shortName ?? `${rec.level} ${rec.matchNumber}`;
        const v = loudnessVerdict(rec.loudness);
        this.set('stream-loudness', v.state, `${name}: ${v.detail}`);
    }

    private checkMixer() {
        const m = this.mixer;
        if (!HWPing.Instance.mixerAddress()) {
            ['dj-stream'].forEach((id) =>
                this.set(id, 'unknown', 'No mixer address')
            );
            return;
        }
        if (!m || !m.reachable) {
            this.set('dj-stream', 'unknown', 'X-Air not answering');
            return;
        }
        if (!m.dj.length) {
            this.set('dj-stream', 'unknown', 'No DJ channel on X-Air');
            return;
        }
        const leaking = m.dj.filter(
            (c) => c.on !== false && (c.streamSendDb ?? -Infinity) > OFF_DB
        );
        if (leaking.length) {
            const c = leaking[0];
            this.set(
                'dj-stream',
                'critical',
                `${c.name} sent to ${m.streamBusName}: ${Math.round(
                    c.streamSendDb!
                )} dB`
            );
        } else {
            this.set('dj-stream', 'ok', `Off ${m.streamBusName}`);
        }
    }

    // FMS (or FTC Live) display input in vMix: unmuted and on Master. On the
    // X-Air, at least one match-sound source unmuted, in the venue (main LR,
    // fader up) and on the stream bus. The venue matters more than the
    // stream, so a missing main mix is critical and a missing stream send a
    // warning.
    private checkMatchSounds(v: any) {
        const problems: { state: CheckState; text: string; fix?: Fix }[] = [];
        const input = this.displayInput(v);
        if (v && !input) {
            problems.push({
                state: 'warning',
                text: 'No FMS / Audience Display input in vMix',
            });
        } else if (input) {
            if (truthy(input.muted))
                problems.push({
                    state: 'critical',
                    text: `${input.title} muted in vMix`,
                    fix: {
                        label: 'Unmute',
                        run: vmixFn('AudioOn', { Input: String(input.key) }),
                    },
                });
            else if (
                !String(input.audiobusses ?? '')
                    .split(',')
                    .includes('M')
            )
                problems.push({
                    state: 'critical',
                    text: `${input.title} not on Master in vMix`,
                    fix: {
                        label: 'Add to Master',
                        run: vmixFn('AudioBusOn', {
                            Input: String(input.key),
                            Value: 'M',
                        }),
                    },
                });
        }
        const m = this.mixer;
        if (m?.reachable && m.game.length) {
            const venue = m.game.filter(
                (s) =>
                    s.on !== false &&
                    s.lr !== false &&
                    (s.faderDb ?? 0) > OFF_DB
            );
            const stream = venue.filter(
                (s) => (s.streamSendDb ?? -Infinity) > OFF_DB
            );
            const g = m.game[0];
            if (!venue.length) {
                let why = 'not in the venue mix';
                if (g.on === false) why = 'muted';
                else if ((g.faderDb ?? 0) <= OFF_DB) why = 'fader down';
                problems.push({
                    state: 'critical',
                    text: `${g.name} ${why} on X-Air`,
                });
            } else if (!stream.length) {
                problems.push({
                    state: 'warning',
                    text: `${venue[0].name} not sent to ${m.streamBusName}`,
                });
            }
        }
        if (!v && !m?.reachable) {
            this.set('match-sounds', 'unknown', 'vMix and X-Air not answering');
            return;
        }
        if (!problems.length) {
            this.set(
                'match-sounds',
                'ok',
                m?.reachable ? 'vMix and X-Air' : 'vMix only'
            );
            return;
        }
        const worst =
            problems.find((p) => p.state === 'critical') ?? problems[0];
        this.set('match-sounds', worst.state, worst.text, worst.fix);
    }

    // Setup's audio check (events/HWCheck.ts), kept running: the X-Air's
    // OUT 1-2 is Windows' default playback device, unmuted, at 100%.
    private checkWindowsAudio() {
        const d = this.winAudio;
        if (process.platform !== 'win32') {
            this.set('windows-audio', 'unknown', 'Not Windows');
            return;
        }
        if (d === undefined) {
            this.set(
                'windows-audio',
                'unknown',
                this.winAudioAt
                    ? 'SoundVolumeView not answering'
                    : 'Not read yet'
            );
            return;
        }
        if (d === null) {
            this.set('windows-audio', 'warning', 'X-Air driver missing');
            return;
        }
        const id = d.control_id || d.name;
        const volume = parseInt(String(d.volume_percent).replace('%', ''), 10);
        if (d.default !== 'Render') {
            this.set('windows-audio', 'critical', 'X-Air OUT 1-2 not default', {
                label: 'Set as default',
                run: () => setDefaultAudioDevice(id, 'all'),
            });
        } else if (d.muted) {
            this.set('windows-audio', 'critical', 'X-Air OUT 1-2 muted', {
                label: 'Unmute',
                run: () => unmuteDevice(id),
            });
        } else if (Number.isFinite(volume) && volume < 100) {
            this.set(
                'windows-audio',
                'warning',
                `X-Air OUT 1-2 at ${volume}%, not 100%`,
                {
                    label: 'Set to 100%',
                    run: () => setVolumePercent(id, 100),
                }
            );
        } else {
            this.set('windows-audio', 'ok', 'X-Air OUT 1-2, default, 100%');
        }
    }

    // The FMS / audience display browser input whose sounds are the match
    // sounds: "FMS" at FRC events, "Audience Display" at FTC events.
    // eslint-disable-next-line class-methods-use-this
    private displayInput(v: any): any {
        const inputs = list<any>(v?.inputs?.input);
        return (
            inputs.find((i) => String(i.title) === 'FMS') ??
            inputs.find((i) => /^fms\b|audience/i.test(String(i.title)))
        );
    }

    private checkBuzzer(v: any) {
        const b = this.buzzer;
        if (!b) return;
        const input = this.displayInput(v);
        if (input) {
            b.peakDb = Math.max(
                b.peakDb,
                meterDb(input.meterF1),
                meterDb(input.meterF2)
            );
        }
        const bus = v?.audio?.busA;
        if (bus) {
            b.busPeakDb = Math.max(
                b.busPeakDb,
                meterDb(bus.meterF1),
                meterDb(bus.meterF2)
            );
        }
        if (Date.now() < b.until) return;
        if (!input) this.set('match-buzzer', 'unknown', 'No FMS input in vMix');
        else if (b.peakDb < -50)
            this.set('match-buzzer', 'warning', `No sound at ${b.label} start`);
        else this.set('match-buzzer', 'ok', `Heard at ${b.label} start`);
        // The start sound played (FMS input) but never reached the stream
        // mix: the path vMix -> X-Air -> Bus A is broken. A quiet room cannot
        // trip this, unlike a silence timer.
        this.busMissedStart =
            b.streaming && b.peakDb >= -50 && b.busPeakDb < -50
                ? `No ${b.label} start sound on Bus A`
                : null;
        this.buzzer = null;
    }

    private checkCaptions(v: any) {
        if (!v) {
            this.set('captions', 'unknown', 'vMix not answering');
            return;
        }
        const input = list<any>(v.inputs?.input).find((i) =>
            /live captions/i.test(String(i.title))
        );
        const overlay = list<any>(v.overlays?.overlay).find(
            (o) => String(o?.number) === String(CAPTIONS_OVERLAY)
        );
        const onOverlay =
            !!input &&
            String(typeof overlay === 'object' ? overlay['#text'] : '') ===
                String(input.number);
        const lcWait = liveCaptionsWait();
        if (lcWait) {
            this.set('captions', 'unknown', lcWait);
            return;
        }
        let problem = '';
        let fix: Fix | undefined;
        if (!LiveCaptions.Instance.isRunning()) {
            problem = 'Live Captions stopped';
            fix = {
                label: 'Start',
                run: async () => {
                    if (!(await LiveCaptions.Instance.start()))
                        throw new Error('Live Captions did not start');
                },
            };
        } else if (!input) {
            problem = 'No Live Captions input in vMix';
            fix = {
                label: 'Add input',
                run: () => VmixService.Instance.AddLiveCaptionsInput(),
            };
        } else if (!onOverlay) {
            problem = `Live Captions not on overlay ${CAPTIONS_OVERLAY}`;
            fix = {
                label: `Put on overlay ${CAPTIONS_OVERLAY}`,
                run: vmixFn(`OverlayInput${CAPTIONS_OVERLAY}In`, {
                    Input: String(input.key),
                }),
            };
        }
        // Captions are set up for the whole event, so a problem counts
        // whether or not a match is on.
        if (problem) this.set('captions', 'warning', problem, fix);
        else this.set('captions', 'ok', `On overlay ${CAPTIONS_OVERLAY}`);
    }

    // The YouTube match-video uploader (FTC events, FRC off-season): up,
    // signed in, no failed uploads, no quota error. Sign-in and the queue
    // come from its event stream.
    private checkUploader() {
        const up = YoutubeUploaderAddon.Instance;
        if (!AutoAV.Instance.runsUploader()) {
            this.set('uploader', 'unknown', 'Not used');
            return;
        }
        const phase = up.getPhase();
        if (phase === 'updating' || phase === 'starting') {
            this.set(
                'uploader',
                'unknown',
                phase === 'updating' ? 'Updating' : 'Starting'
            );
            return;
        }
        if (phase !== 'running') {
            if (!AutoAV.Instance.getStatus().saveFolder)
                this.set('uploader', 'unknown', 'No event folder');
            else
                this.set('uploader', 'warning', 'Stopped', {
                    label: 'Start',
                    run: async () => {
                        if (!(await up.start()))
                            throw new Error('Uploader did not start');
                    },
                });
            return;
        }
        const { latest, connected } = up.events;
        if (!connected) {
            this.set('uploader', 'unknown', 'No status yet');
            return;
        }
        const hello = latest.get('hello') as any;
        const signin = (latest.get('signin') ?? hello?.signin) as
            | { signedIn: boolean; channel: string | null }
            | undefined;
        const queue = (latest.get('queue') ?? hello?.queue) as
            | { counts?: Record<string, number> }
            | undefined;
        const failed = queue?.counts?.failed ?? 0;
        if (signin && !signin.signedIn) {
            this.set('uploader', 'warning', 'YouTube sign-in needed');
        } else if (this.uploadQuota) {
            this.set('uploader', 'warning', this.uploadQuota);
        } else if (failed > 0) {
            this.set(
                'uploader',
                'warning',
                `${failed} upload${failed === 1 ? '' : 's'} failed`
            );
        } else {
            const done = queue?.counts?.uploaded ?? 0;
            this.set(
                'uploader',
                'ok',
                `${signin?.channel ?? 'Signed in'}, ${done} uploaded`
            );
        }
    }

    // The custom audience display (FRC off-season, when Settings picks it):
    // running, connected to FMS, its last error, and which profile it chose
    // (it picks one from the FMS event code itself).
    private checkAudienceDisplay() {
        const ad = AudienceDisplayAddon.Instance;
        if (!AutoAV.Instance.runsCustomAd()) {
            this.set('audience-display', 'unknown', 'Not used');
            return;
        }
        const phase = ad.getPhase();
        if (phase === 'updating' || phase === 'starting') {
            this.set(
                'audience-display',
                'unknown',
                phase === 'updating' ? 'Updating' : 'Starting'
            );
            return;
        }
        if (phase !== 'running') {
            this.set('audience-display', 'warning', 'Stopped', {
                label: 'Start',
                run: async () => {
                    if (!(await ad.start()))
                        throw new Error('Audience display did not start');
                },
            });
            return;
        }
        const { latest, connected } = ad.events;
        if (!connected) {
            this.set('audience-display', 'unknown', 'No status yet');
            return;
        }
        const hello = latest.get('hello') as any;
        const fms = (latest.get('fms') ?? hello?.fms) as
            | { connected: boolean; eventCode: string | null }
            | undefined;
        const profile = (latest.get('profile') ?? hello?.profile) as
            | { name: string }
            | undefined;

        if (fms && !fms.connected) {
            this.set('audience-display', 'warning', 'Not connected to FMS');
        } else if (this.adError) {
            this.set('audience-display', 'warning', this.adError);
        } else {
            this.set(
                'audience-display',
                'ok',
                profile ? `Profile: ${profile.name}` : 'Running'
            );
        }
    }

    // The transcription engine inside live-captions, from its event stream
    // (no verdict until it is connected).
    private checkCaptionsEngine() {
        const wait = liveCaptionsWait();
        if (!LiveCaptions.Instance.isRunning()) {
            this.set(
                'captions-engine',
                'unknown',
                wait ?? 'Live Captions stopped'
            );
            return;
        }
        const ev = LiveCaptions.Instance.events;
        const e = ev.connected ? captionEngine() : null;
        if (!e) {
            this.set('captions-engine', 'unknown', 'No status yet');
        } else if (e.state === 'error') {
            this.set('captions-engine', 'warning', e.error || 'Engine error', {
                label: 'Restart',
                run: async () => {
                    await LiveCaptions.Instance.stop();
                    if (!(await LiveCaptions.Instance.start()))
                        throw new Error('Live Captions did not start');
                },
            });
        } else if (e.state === 'stopped') {
            this.set('captions-engine', 'warning', 'No inputs');
        } else if (e.state === 'restarting') {
            this.set('captions-engine', 'unknown', 'Restarting');
        } else {
            this.set('captions-engine', 'ok', 'Transcribing');
        }
    }

    // live-captions sends captions to YouTube by the stream key. The key it
    // holds must be the one vMix streams with: the live stream's, or the
    // settings' before going live. At official FRC events the volunteers
    // may not be given a caption key, so a problem there is shown without
    // a warning: the detail and the fix stay for a crew that has the key.
    private checkCaptionsYoutube(streaming: boolean) {
        if (!LiveCaptions.Instance.isRunning()) {
            this.set(
                'captions-youtube',
                'unknown',
                liveCaptionsWait() ?? 'Live Captions stopped'
            );
            return;
        }
        const p = this.captionPush;
        if (!p) {
            this.set(
                'captions-youtube',
                'unknown',
                'Live Captions not answering'
            );
            return;
        }
        const live = (this.bandwidth?.streams ?? []).find((s) =>
            /youtube/i.test(s.rtmpUrl)
        );
        const streamKey =
            (streaming && live ? streamKeyFromUrl(live.rtmpUrl) : null) ||
            this.settings?.youtubeKey ||
            null;
        const key = keyFromCaptionUrl(p.url);
        const warn: CheckState =
            !AutoAV.Instance.isFtc() && !AutoAV.Instance.isOffSeason()
                ? 'unknown'
                : 'warning';
        const setKey: Fix | undefined = streamKey
            ? { label: 'Set key', run: () => setCaptionKey(streamKey) }
            : undefined;
        if (!key) {
            this.set(
                'captions-youtube',
                warn,
                'No YouTube caption key',
                setKey
            );
        } else if (streamKey && key !== streamKey) {
            this.set(
                'captions-youtube',
                warn,
                'Caption key not the stream key',
                setKey
            );
        } else if (!p.enabled) {
            this.set('captions-youtube', warn, 'YouTube captions off', {
                label: 'Turn on',
                run: enableCaptionPush,
            });
        } else if (
            this.held('captions-push-error', streaming && !!p.lastError, 30000)
        ) {
            this.set('captions-youtube', warn, p.lastError!);
        } else {
            this.set('captions-youtube', 'ok', 'Key set');
        }
    }

    // #endregion

    // #region match start / end

    private beginMatch(label: string, host: string | null) {
        this.buzzer = {
            label,
            until: Date.now() + 4000,
            peakDb: -Infinity,
            busPeakDb: -Infinity,
            streaming: !!this.vmix && truthy(this.vmix.streaming),
        };
        if (!host || !this.mixer?.reachable) return;
        // Sampled from the meter packets (meters.onData, set in start()).
        this.balance = { label, mic: [], game: [] };
    }

    private endMatch() {
        const b = this.balance;
        this.balance = null;
        if (!b) return;
        // Typical loud level of each while it is sounding.
        const mic = percentile(b.mic, 0.9);
        const game = percentile(b.game, 0.9);
        if (
            mic === null ||
            game === null ||
            b.mic.length < 6 ||
            b.game.length < 6
        ) {
            this.set(
                'mic-balance',
                'unknown',
                `Not enough sound in ${b.label}`
            );
            return;
        }
        const diff = Math.round(mic - game);
        if (diff > BALANCE_DB)
            this.set(
                'mic-balance',
                'warning',
                `Mics ${diff} dB over match sounds (${b.label})`
            );
        else if (-diff > BALANCE_DB)
            this.set(
                'mic-balance',
                'warning',
                `Match sounds ${-diff} dB over mics (${b.label})`
            );
        else
            this.set(
                'mic-balance',
                'ok',
                `${Math.abs(diff)} dB apart (${b.label})`
            );
    }

    // Each source's level on the stream bus: its meter plus fader and send
    // (rough: assumes post-fader sends). Only samples where the source is
    // sounding count, so a mic between announcements is not "quiet".
    private sampleBalance() {
        const b = this.balance;
        const m = this.mixer;
        const levels = this.meters.latest;
        if (
            !b ||
            !m ||
            !levels.length ||
            Date.now() - this.meters.lastAt > 2000
        )
            return;
        const onBus = (s: MixerSource) => {
            const raw = levels[s.meter];
            if (raw === undefined || raw < -50 || s.on === false) return null;
            return raw + (s.faderDb ?? 0) + (s.streamSendDb ?? -Infinity);
        };
        const best = (xs: MixerSource[]) =>
            xs
                .map(onBus)
                .filter((x): x is number => x !== null && Number.isFinite(x));
        const mic = best(m.mics);
        const game = best(m.game);
        if (mic.length) b.mic.push(Math.max(...mic));
        if (game.length) b.game.push(Math.max(...game));
    }

    // Whether someone is talking: a mic (the channels readMixer() takes as
    // mics) over TALK_DB on its input meter, taken back to the reference
    // preamp gain (+20 dB): the meter is after the preamp, so a mic turned
    // up or down would otherwise move the gate. /meters/1 channel meters are
    // pre-fader, so this is the voice at the mic, whatever its fader, mute,
    // send or the bus masters are set to. Someone talking into a mic that is
    // turned down, muted or off the stream bus is talking: the stream being
    // quiet then is the problem the loudness check is there to find.
    private noteTalking() {
        const m = this.mixer;
        const levels = this.meters.latest;
        if (!m || !levels.length) return;
        const live = m.mics.some((s) => {
            const raw = levels[s.meter];
            return raw !== undefined && atRefGain(s, raw) >= TALK_DB;
        });
        talkLog.note(this.meters.lastAt, live);
    }

    // #endregion

    private publish() {
        const now = Date.now();
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        let changed = false;
        Object.keys(ignored).forEach((id) => {
            if (ignored[id] <= now) {
                delete ignored[id];
                changed = true;
            }
        });
        if (changed) getStore().set('checks.ignoredUntil', ignored);

        this.results.forEach((r, id) => {
            const until = ignored[id] ?? null;
            const next = { ...r, ignoredUntil: until };
            this.results.set(id, next);
            const failing = isAlerting(next);
            if (failing && !this.notified.has(id)) {
                this.notified.add(id);
                this.emit('alert', next);
            }
            if (!failing) this.notified.delete(id);
        });
        this.emit('checks', this.list());
    }

    public static get Instance(): Checks {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}

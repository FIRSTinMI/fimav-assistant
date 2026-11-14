import dgram from 'dgram';

// OSC to a Behringer X-Air mixer (XR12/16/18) on UDP 10024. Sending an
// address with no arguments asks the mixer for its value; it answers on the
// same socket with the address and one argument. Addresses are Behringer's
// X-Air Parameters.txt (XR18 firmware 1.14):
//   /ch/NN/config/name       channel name (s)
//   /ch/NN/mix/on            1 = unmuted (i)
//   /ch/NN/mix/fader         0..1, 0.75 = 0 dB (f, 1024 steps)
//   /ch/NN/mix/lr            1 = assigned to the main mix (i)
//   /ch/NN/mix/BB/level      send level to bus BB, 0..1 (f, 161 steps)
//   /ch/NN/mix/BB/tap        send tap: IN, PREEQ, POSTEQ, PRE, POST, GRP (i)
//   /rtn/aux/...             the same for the aux/USB return (17+18)
//   /bus/N/mix/fader         bus master fader (f, 1024 steps)
//   /lr/mix/fader            main LR fader (f, 1024 steps)
// The checks only read. The level wizard (levelWizard.ts) is the one writer:
// faders and sends, through setXair(), each write read back.

export const XAIR_PORT = 10024;

type OscValue = string | number;

function pad4(b: Buffer): Buffer {
    const len = Math.ceil((b.length + 1) / 4) * 4;
    const out = Buffer.alloc(len);
    b.copy(out);
    return out;
}

// An OSC message with an address and no arguments.
export function encodeQuery(address: string): Buffer {
    return Buffer.concat([
        pad4(Buffer.from(address, 'ascii')),
        pad4(Buffer.from(',', 'ascii')),
    ]);
}

function readString(buf: Buffer, at: number): [string, number] {
    const end = buf.indexOf(0, at);
    const s = buf.toString('ascii', at, end);
    return [s, Math.ceil((end + 1) / 4) * 4];
}

// The address and first argument of an OSC reply, or null.
export function decodeReply(
    buf: Buffer
): { address: string; value: OscValue } | null {
    try {
        const [address, a] = readString(buf, 0);
        const [tags, b] = readString(buf, a);
        if (!tags.startsWith(',') || tags.length < 2) return null;
        switch (tags[1]) {
            case 'i':
                return { address, value: buf.readInt32BE(b) };
            case 'f':
                return { address, value: buf.readFloatBE(b) };
            case 's':
                return { address, value: readString(buf, b)[0] };
            default:
                return null;
        }
    } catch {
        return null;
    }
}

// Ask the mixer for several addresses at once. Answers that do not arrive
// within `timeoutMs` are missing from the result.
export function queryXair(
    host: string,
    addresses: string[],
    timeoutMs = 800,
    port = XAIR_PORT
): Promise<Map<string, OscValue>> {
    // A channel can match two roles (e.g. named "vMix" and "DJ"); ask once.
    const wanted = [...new Set(addresses)];
    return new Promise((resolve) => {
        const results = new Map<string, OscValue>();
        const socket = dgram.createSocket('udp4');
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // already closed
            }
            resolve(results);
        };
        const timer = setTimeout(finish, timeoutMs);
        socket.on('message', (msg) => {
            const reply = decodeReply(msg);
            if (reply && wanted.includes(reply.address)) {
                results.set(reply.address, reply.value);
                if (results.size === wanted.length) finish();
            }
        });
        socket.on('error', finish);
        socket.bind(0, () => {
            wanted.forEach((a) =>
                socket.send(encodeQuery(a), port, host, () => undefined)
            );
        });
    });
}

// The fader law and the preamp gain law: utils/xairLaw.ts (shared with
// the UI's on-screen fader).
export {
    dbToLevel,
    FADER_STEPS,
    GAIN_MAX_DB,
    GAIN_MIN_DB,
    GAIN_STEPS,
    gainToLevel,
    LEVEL_STEPS,
    levelToDb,
    levelToGain,
    MAX_DB,
} from '../../utils/xairLaw';

type OscArg = string | number | { float: number };

// An OSC message with string, int ({float} for float) arguments.
function encodeMessage(address: string, args: OscArg[]): Buffer {
    const tag = (a: OscArg) => {
        if (typeof a === 'string') return 's';
        return typeof a === 'number' ? 'i' : 'f';
    };
    const tags = `,${args.map(tag).join('')}`;
    const parts = [
        pad4(Buffer.from(address, 'ascii')),
        pad4(Buffer.from(tags, 'ascii')),
    ];
    args.forEach((a) => {
        if (typeof a === 'string') parts.push(pad4(Buffer.from(a, 'ascii')));
        else {
            const b = Buffer.alloc(4);
            if (typeof a === 'number') b.writeInt32BE(a);
            else b.writeFloatBE(a.float);
            parts.push(b);
        }
    });
    return Buffer.concat(parts);
}

// An OSC message setting one float parameter.
export const encodeSetFloat = (address: string, value: number) =>
    encodeMessage(address, [{ float: value }]);

// One parameter to set: a float (faders, sends, gains) unless `int` (on/off
// switches such as grpon).
export interface XairWrite {
    address: string;
    value: number;
    int?: boolean;
}

const encodeWrite = (w: XairWrite) =>
    w.int
        ? encodeMessage(w.address, [Math.round(w.value)])
        : encodeSetFloat(w.address, w.value);

// Send parameter sets without waiting for anything (an on-screen fader
// being dragged).
export function writeXair(
    host: string,
    writes: XairWrite[],
    port = XAIR_PORT
): Promise<void> {
    return new Promise<void>((resolve) => {
        const socket = dgram.createSocket('udp4');
        let left = writes.length;
        const done = () => {
            try {
                socket.close();
            } catch {
                // already closed
            }
            resolve();
        };
        if (!left) {
            done();
            return;
        }
        socket.on('error', done);
        socket.bind(0, () =>
            writes.forEach((w) =>
                socket.send(encodeWrite(w), port, host, () => {
                    left -= 1;
                    if (left === 0) done();
                })
            )
        );
    });
}

// Set parameters, then read them back. Resolves with what the mixer holds
// afterwards; a value missing from the result did not answer. The X-Air
// does not acknowledge a set, so the read-back is the only proof it took.
export async function setXair(
    host: string,
    writes: XairWrite[],
    port = XAIR_PORT
): Promise<Map<string, OscValue>> {
    await writeXair(host, writes, port);
    return queryXair(
        host,
        writes.map((w) => w.address),
        800,
        port
    );
}

// Live meters (/meters/1), in dBFS (int16 / 256). Per Parameters.txt:
// 16x ch pre(-fader), aux pre L/R, fx1..4 pre L/R, bus1..6 pre, fxsend1..4
// pre, main post L/R, mon L/R (40 values). The subscription lapses after
// 10 s, so it is renewed every 9 s while running.
export const METER_AUX_L = 16;
export const METER_AUX_R = 17;
// Bus N's meter (pre its master fader) is METER_BUS + N - 1.
export const METER_BUS = 26;
export const METER_LR_L = 36;
export const METER_LR_R = 37;

export class XairMeters {
    private socket: dgram.Socket | null = null;

    private renew: ReturnType<typeof setInterval> | null = null;

    private host = '';

    // Latest meter values in dB, index as above; empty until data arrives.
    public latest: number[] = [];

    public lastAt = 0;

    // Called on every meter packet (about every 50 ms while subscribed).
    public onData: (() => void) | null = null;

    public start(host: string) {
        if (this.socket && this.host === host) return;
        this.stop();
        this.host = host;
        const socket = dgram.createSocket('udp4');
        this.socket = socket;
        socket.on('message', (msg) => this.onMessage(msg));
        socket.on('error', () => this.stop());
        const subscribe = () =>
            socket.send(
                encodeMessage('/meters', ['/meters/1']),
                XAIR_PORT,
                host,
                () => undefined
            );
        socket.bind(0, subscribe);
        this.renew = setInterval(subscribe, 9000);
    }

    public stop() {
        if (this.renew) clearInterval(this.renew);
        this.renew = null;
        try {
            this.socket?.close();
        } catch {
            // already closed
        }
        this.socket = null;
    }

    private onMessage(msg: Buffer) {
        try {
            const [address, a] = readString(msg, 0);
            if (address !== '/meters/1') return;
            const [tags, b] = readString(msg, a);
            if (tags !== ',b') return;
            const size = msg.readInt32BE(b);
            const blob = msg.subarray(b + 4, b + 4 + size);
            const count = blob.readInt32LE(0);
            const values: number[] = [];
            for (let i = 0; i < count && 4 + i * 2 + 1 < blob.length; i += 1) {
                values.push(blob.readInt16LE(4 + i * 2) / 256);
            }
            this.latest = values;
            this.lastAt = Date.now();
            this.onData?.();
        } catch {
            // a malformed packet is skipped
        }
    }
}

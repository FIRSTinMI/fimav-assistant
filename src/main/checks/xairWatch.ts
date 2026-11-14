import dgram from 'dgram';
import { decodeReply, encodeQuery, XAIR_PORT } from './xair';

// Parameter changes pushed by the mixer. After /xremote the X-Air sends
// every change made on it (any app or the surface) to this socket for 10 s,
// so it is renewed every 9 s. The checks use it as "something changed, read
// the settings again"; the level wizard also takes each pushed parameter
// (address and value), so a fader moved on the desk shows at once.
// Nothing here writes to the mixer.
export default class XairWatch {
    private socket: dgram.Socket | null = null;

    private renew: ReturnType<typeof setInterval> | null = null;

    private host = '';

    public onChange: (() => void) | null = null;

    // Every pushed parameter: its address and new value.
    public onParam:
        | ((_address: string, _value: string | number) => void)
        | null = null;

    // Last time the mixer sent anything, so a silent subscription is known.
    public lastAt = 0;

    public start(host: string, port = XAIR_PORT) {
        if (this.socket && this.host === host) return;
        this.stop();
        this.host = host;
        const socket = dgram.createSocket('udp4');
        this.socket = socket;
        socket.on('message', (msg) => {
            this.lastAt = Date.now();
            const end = msg.indexOf(0);
            const address = msg.toString('ascii', 0, end < 0 ? 0 : end);
            if (address.startsWith('/meters')) return;
            const p = decodeReply(msg);
            if (p) this.onParam?.(p.address, p.value);
            this.onChange?.();
        });
        socket.on('error', () => this.stop());
        const subscribe = () =>
            socket.send(encodeQuery('/xremote'), port, host, () => undefined);
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
}

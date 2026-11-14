import net from 'net';
import { EventEmitter } from 'events';

// vMix's TCP API (port 8099) pushes activator events after SUBSCRIBE ACTS:
//   ACTS OK InputAudio 10 1      input 10 audio on/off
//   ACTS OK Overlay8 13 1        input 13 on/off overlay 8
//   ACTS OK BusAAudio 0          Bus A muted/unmuted (also MasterAudio)
//   ACTS OK InputBusAAudio 10 1  input 10 on/off Bus A (InputMasterAudio...)
//   ACTS OK Recording 1 / Streaming 1
// (recorded from vMix 29 while toggling each). The checks only use them as
// "something changed, read vMix again"; the state itself still comes from
// the API XML. Reconnects every 5 s while vMix is closed.

export const VMIX_TCP_PORT = 8099;

export default class VmixEvents extends EventEmitter {
    private socket: net.Socket | null = null;

    private retry: ReturnType<typeof setTimeout> | null = null;

    private host = '';

    private stopped = true;

    public connected = false;

    public start(host: string) {
        if (!this.stopped && this.host === host) return;
        this.stop();
        this.stopped = false;
        this.host = host;
        this.connect();
    }

    public stop() {
        this.stopped = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
    }

    private connect() {
        const socket = net.connect(VMIX_TCP_PORT, this.host);
        this.socket = socket;
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            this.connected = true;
            socket.write('SUBSCRIBE ACTS\r\n');
            this.emit('change');
        });
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\r\n');
            buffer = lines.pop() ?? '';
            lines.forEach((line) => {
                if (line.startsWith('ACTS OK ')) this.emit('change', line);
            });
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
            if (this.socket !== socket) return;
            const was = this.connected;
            this.connected = false;
            this.socket = null;
            if (was) this.emit('change');
            if (!this.stopped)
                this.retry = setTimeout(() => this.connect(), 5000);
        });
    }
}

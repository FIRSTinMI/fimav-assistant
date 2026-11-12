import WebSocket from 'ws';

// Companion 3.x and 4.0 have no tRPC: their web UI talks socket.io (server
// v4, Engine.IO protocol 4) and every call is an event with an ack callback
// that answers (error, result). This speaks just enough of that protocol over
// a plain WebSocket for those calls, so the app does not carry a
// socket.io-client dependency for old Companions only.
//
// Engine.IO frames used: "0{...}" open, "2" ping (answered "3"), "4..."
// message. Socket.IO packets inside a message: "0" connect, "2" event,
// "3" ack, each optionally followed by an ack id and a JSON array.

const TIMEOUT_MS = 8000;

export default class SocketIoSession {
    private ws: WebSocket;

    private nextId = 0;

    private waiting = new Map<number, (_args: any[]) => void>();

    // 3.0-3.2 spread the call's arguments into the event; 3.3 and later send
    // them as one array (Handler.onPromise changed to `(args, cb)` in 3.3.0).
    private argsAsArray: boolean;

    private constructor(ws: WebSocket, argsAsArray: boolean) {
        this.ws = ws;
        this.argsAsArray = argsAsArray;
        ws.on('message', (data, isBinary) => {
            // Binary frames carry button images; no call answers with one.
            if (!isBinary) this.onFrame(String(data));
        });
    }

    private onFrame(frame: string) {
        if (frame === '2') {
            this.ws.send('3');
            return;
        }
        if (!frame.startsWith('43')) return; // only acks are awaited
        const m = /^43(\d+)(.*)$/s.exec(frame);
        if (!m) return;
        const cb = this.waiting.get(Number(m[1]));
        if (!cb) return;
        this.waiting.delete(Number(m[1]));
        let args: any[] = [];
        try {
            args = JSON.parse(m[2] || '[]');
        } catch {
            args = [];
        }
        cb(args);
    }

    static open(baseUrl: string, argsAsArray = true): Promise<SocketIoSession> {
        const url = `${baseUrl.replace(
            /^http/,
            'ws'
        )}/socket.io/?EIO=4&transport=websocket`;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new Error('Companion did not answer'));
            }, TIMEOUT_MS);
            const fail = (e: Error) => {
                clearTimeout(timer);
                ws.terminate();
                reject(e);
            };
            ws.once('error', fail);
            // The namespace is joined once Engine.IO has opened; the call
            // channel is ready when the server confirms with "40{sid}".
            const onOpenFrame = (data: WebSocket.RawData) => {
                const f = String(data);
                if (f.startsWith('0')) {
                    ws.send('40');
                } else if (f.startsWith('40')) {
                    ws.off('message', onOpenFrame);
                    clearTimeout(timer);
                    resolve(new SocketIoSession(ws, argsAsArray));
                } else if (f.startsWith('44')) {
                    fail(new Error(`Companion refused: ${f.slice(2)}`));
                }
            };
            ws.on('message', onOpenFrame);
        });
    }

    call(name: string, args: unknown[]): Promise<any> {
        this.nextId += 1;
        const id = this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`Companion: ${name} timed out`));
            }, TIMEOUT_MS);
            this.waiting.set(id, ([err, result]) => {
                clearTimeout(timer);
                if (err) reject(new Error(`Companion: ${name}: ${err}`));
                else resolve(result);
            });
            const payload = this.argsAsArray ? [name, args] : [name, ...args];
            this.ws.send(`42${id}${JSON.stringify(payload)}`);
        });
    }

    close() {
        this.ws.close();
    }
}

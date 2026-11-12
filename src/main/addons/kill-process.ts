import { execSync } from 'child_process';
import { LogFunctions } from 'electron-log';

const kill = (pid: string): boolean => {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false; // already gone
    }
};

// Kill every <name>*.exe process, tracked or orphaned, then whatever process
// is still LISTENING on the port. Only the local address of a listening
// socket counts: a line where the port is the REMOTE end is a client of the
// addon (FIM-AV's own keep-alive fetches, vMix's browser input) and must not
// be killed. Our own PID is never killed.
export default function killByNameAndPort(
    name: string,
    port: number,
    logger: LogFunctions
): void {
    const self = String(process.pid);

    // By image name. taskkill's IMAGENAME wildcard filter is rejected on some
    // Win11 builds, so enumerate with tasklist and kill by PID.
    try {
        const tl = execSync('tasklist /fo csv /nh').toString();
        const re = new RegExp(`^"(${name}[^"]*\\.exe)","(\\d+)"`, 'i');
        tl.split(/\r?\n/).forEach((line) => {
            const m = re.exec(line.trim());
            if (m && m[2] !== self) kill(m[2]);
        });
    } catch {
        // tasklist unavailable (non-Windows dev box) - ignore.
    }

    try {
        // No -p filter: "-p tcp" lists IPv4 only, and a dual-stack listener
        // shows up only under IPv6.
        const out = execSync('netstat -ano').toString();
        const pids = new Set<string>();
        out.split(/\r?\n/).forEach((line) => {
            // Proto, Local Address, Foreign Address, State, PID
            const cols = line.trim().split(/\s+/);
            if (cols.length !== 5 || cols[0].toUpperCase() !== 'TCP') return;
            const [, local, , state, pid] = cols;
            if (state !== 'LISTENING') return;
            if (!local.endsWith(`:${port}`)) return;
            if (!/^\d+$/.test(pid) || pid === '0' || pid === self) return;
            pids.add(pid);
        });
        pids.forEach((pid) => {
            if (kill(pid)) logger.log(`Freed port ${port} (killed PID ${pid})`);
        });
    } catch {
        // netstat unavailable (non-Windows dev box) - ignore.
    }
}

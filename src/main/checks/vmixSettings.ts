import fs from 'fs';
import path from 'path';

// vMix autosaves its whole state to %APPDATA%\last.vmix about once a minute.
// Read only, and re-read only when its mtime changes. Field meanings were
// found on vMix 29 by changing one setting at a time and diffing the file:
//
//   <StreamingSettings SelectedIndex="2"> <StreamingSetting>... one entry per
//   saved stream profile; SelectedIndex is the one in use. In it:
//     <AudioChannel>  stream audio source: 0 = Master, 10 = Bus A
//     <Source>        stream video source: 0 = Output 1, 1 = Output 2
//     <Destination0..2> streams 1-3, escaped XML holding <URL> and <Stream>
//   <RecordingSettings> (recorder 1) <Channel>: 0 = Output 1, 1 = Output 2;
//     <AudioChannel> as for the stream
//   <OutputsExternal2> (Output 2) <Overlay0>..<Overlay15>: 1 = overlay
//     channel 1..16 shown on that output.

export interface VmixStreamSettings {
    // "Bus A", "Master", or "audio source <n>" for a value not yet mapped
    audioBus: string | null;
    // 1-based output number the stream shows
    output: number | null;
    // Overlay channels (1-based) shown on Output 2
    output2Overlays: number[] | null;
    // 1-based output number recorder 1 records
    recordOutput: number | null;
    // Recorder 1's audio source, named as audioBus
    recordAudioBus: string | null;
    // Stream key of the first YouTube destination
    youtubeKey: string | null;
}

let cache: { mtimeMs: number; value: VmixStreamSettings | null } | null = null;

export function lastVmixPath(): string {
    return path.join(process.env.APPDATA ?? '', 'last.vmix');
}

const field = (xml: string, tag: string): number | null => {
    const m = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(xml);
    return m ? parseInt(m[1], 10) : null;
};

function selectedStream(xml: string): string | null {
    const open = /<StreamingSettings\b[^>]*SelectedIndex="(\d+)"[^>]*>/.exec(
        xml
    );
    if (!open) return null;
    const end = xml.indexOf('</StreamingSettings>', open.index);
    const body = xml.slice(open.index, end < 0 ? undefined : end);
    const entry = body.split('<StreamingSetting>')[parseInt(open[1], 10) + 1];
    return entry ? entry.split('</StreamingSetting>')[0] : null;
}

function output2Overlays(xml: string): number[] | null {
    const m = /<OutputsExternal2>([\s\S]*?)<\/OutputsExternal2>/.exec(xml);
    if (!m) return null;
    return [...m[1].matchAll(/<Overlay(\d+)>1<\/Overlay\1>/g)].map(
        (o) => parseInt(o[1], 10) + 1
    );
}

function youtubeKey(entry: string): string | null {
    const dests = [
        ...entry.matchAll(/<Destination\d>([\s\S]*?)<\/Destination\d>/g),
    ].map((d) => d[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    const yt = dests.find((d) => /<URL>[^<]*youtube/i.test(d));
    const key = yt && /<Stream>([^<]+)<\/Stream>/.exec(yt);
    return key ? key[1].trim() : null;
}

function busName(v: number | null): string | null {
    if (v === null) return null;
    if (v === 10) return 'Bus A';
    if (v === 0) return 'Master';
    return `audio source ${v}`;
}

function recordOutput(xml: string): number | null {
    const m = /<RecordingSettings>([\s\S]*?)<\/RecordingSettings>/.exec(xml);
    const ch = m && field(m[1], 'Channel');
    return ch === null || ch === undefined ? null : ch + 1;
}

export function parseStreamSettings(xml: string): VmixStreamSettings | null {
    const entry = selectedStream(xml);
    if (!entry) return null;
    const rec = /<RecordingSettings>([\s\S]*?)<\/RecordingSettings>/.exec(xml);
    const source = field(entry, 'Source');
    return {
        audioBus: busName(field(entry, 'AudioChannel')),
        output: source === null ? null : source + 1,
        output2Overlays: output2Overlays(xml),
        youtubeKey: youtubeKey(entry),
        recordOutput: recordOutput(xml),
        recordAudioBus: rec ? busName(field(rec[1], 'AudioChannel')) : null,
    };
}

// The stream settings vMix last autosaved, or null when the file is missing
// or not understood.
export function readStreamSettings(
    file = lastVmixPath()
): VmixStreamSettings | null {
    try {
        const { mtimeMs } = fs.statSync(file);
        if (cache?.mtimeMs === mtimeMs) return cache.value;
        const value = parseStreamSettings(fs.readFileSync(file, 'utf8'));
        cache = { mtimeMs, value };
        return value;
    } catch {
        return null;
    }
}

// Calls `onChange` when vMix rewrites its autosave. The folder is watched,
// not the file, so a write by replace is still seen. Returns a stop function.
export function watchStreamSettings(
    onChange: () => void,
    file = lastVmixPath()
): () => void {
    try {
        const name = path.basename(file).toLowerCase();
        const watcher = fs.watch(path.dirname(file), (_e, f) => {
            if (f && String(f).toLowerCase() === name) onChange();
        });
        watcher.on('error', () => undefined);
        return () => watcher.close();
    } catch {
        return () => undefined;
    }
}

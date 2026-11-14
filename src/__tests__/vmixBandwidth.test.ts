import { parseAudioBus } from '../main/vmixBandwidth';

jest.mock('electron-log', () => ({ warn: jest.fn() }));

// The ffmpeg command line vMix 29 writes at the top of a stream log.
const cmd = (audio: string) =>
    `"C:\\\\Program Files (x86)\\\\vMix\\\\streaming\\\\ffmpeg2.exe" -report -rtbufsize 128M -f dshow -i "video=vMix Video YV12:audio=${audio}" -codec:v libx264 -f flv rtmp://x.rtmp.youtube.com/live2/key`;

describe('stream log audio bus', () => {
    it('reads the bus from the dshow audio device', () => {
        expect(parseAudioBus(cmd('vMix Audio - Bus A'))).toBe('Bus A');
        expect(parseAudioBus(cmd('vMix Audio - Bus B'))).toBe('Bus B');
        expect(parseAudioBus(cmd('vMix Audio'))).toBe('Master');
        expect(parseAudioBus('no command line')).toBeNull();
    });
});

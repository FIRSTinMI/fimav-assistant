// When someone is talking on the mics, from the X-Air's input meters
// (/meters/1, the mic channels readMixer() finds). The stream loudness check
// judges the stream only while someone talks: between announcements the
// stream is quiet on purpose and is not "too quiet".
//
// Two lists of wall-clock spans (epoch ms):
//  - heard: the mic meters were being read (gaps over METER_GAP_MS end one)
//  - talk:  a mic was over TALK_DB on its pre-fader input meter (no fader,
//           mute or send changes it), held HANGOVER_MS past its last packet
//           so the gaps between words do not end the span
// Kept in memory for KEEP_MS; a match measured after an app restart has no
// mic levels and gets no verdict.

// A mic input over this (dBFS, pre-fader input meter) is someone talking.
// Speech on a set-up wireless mic peaks around -30 to -10 dBFS; an idle
// mic's noise floor sits well under -50.
export const TALK_DB = -40;

// How long a span stays open after the last packet over TALK_DB.
export const HANGOVER_MS = 1000;

// Talking needed in a video before its loudness gets a verdict.
export const MIN_TALK_SECONDS = 3;

// No meter packet for this long: the mics were not being read.
export const METER_GAP_MS = 2000;

const KEEP_MS = 6 * 60 * 60 * 1000;

export type Span = [number, number];

export class TalkLog {
    public heard: Span[] = [];

    public talk: Span[] = [];

    // One meter reading at time t: whether any mic on the stream was over
    // TALK_DB.
    public note(t: number, talking: boolean) {
        const h = this.heard[this.heard.length - 1];
        if (h && t >= h[0] && t - h[1] <= METER_GAP_MS) h[1] = t;
        else this.heard.push([t, t]);
        if (talking) {
            const s = this.talk[this.talk.length - 1];
            if (s && t >= s[0] && t <= s[1]) s[1] = t + HANGOVER_MS;
            else this.talk.push([t, t + HANGOVER_MS]);
        }
        const old = t - KEEP_MS;
        while (this.heard.length && this.heard[0][1] < old) this.heard.shift();
        while (this.talk.length && this.talk[0][1] < old) this.talk.shift();
    }

    public clear() {
        this.heard = [];
        this.talk = [];
    }
}

// The one log the checks engine writes and the loudness jobs read.
export const talkLog = new TalkLog();

export const inSpans = (spans: Span[], t: number) =>
    spans.some(([a, b]) => t >= a && t <= b);

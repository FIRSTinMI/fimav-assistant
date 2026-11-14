# FIM AV software map

Every program that runs on or around an FIM AV cart, and what talks to what. Drawn from the
code of each repo (fimav-assistant, audience-display v26.7, live-captions, youtube-tba-upload
v0.1.9, ftc-vmix-autoav, fake-fms, FMS 2026).

## System diagram

Solid arrows are built and in use. Dashed arrows are the older hand-run FTC tool, which
FIM-AV's FTC mode replaces.

```mermaid
flowchart LR
    classDef app fill:#1f3a5f,stroke:#5b9bd5,color:#fff
    classDef exe fill:#2d4a2d,stroke:#7cbf7c,color:#fff
    classDef third fill:#4a3b1f,stroke:#d5a85b,color:#fff
    classDef field fill:#4a1f1f,stroke:#d55b5b,color:#fff
    classDef cloud fill:#333,stroke:#aaa,color:#fff
    classDef ftc fill:#3b2d4a,stroke:#b07cd5,color:#fff,stroke-dasharray:4 3

    subgraph CART["AV cart (Windows)"]
        direction TB
        FIMAV["FIM-AV Assistant<br/>Electron app<br/>status API :7780"]:::app
        subgraph INPROC["in-process"]
            AUTOAV["AutoAV<br/>records + files matches<br/>fimav-matches.json"]:::app
            HWPING["HW ping<br/>switch, PTZ, mixer, internet"]:::app
            BFMOD["Bitfocus module<br/>button editor + triggers"]:::app
            FTCMOD["FTC module<br/>scorekeeper client + recorder"]:::app
        end
        subgraph SPAWNED["spawned exes (downloaded from GitHub releases)"]
            LC["live-captions.exe<br/>Node via pkg · :3000"]:::exe
            YTU["youtube-tba-upload.exe<br/>Go · :8807"]:::exe
            CAD["audience-display.exe<br/>Bun · :3001"]:::exe
        end
        VMIX["vMix<br/>HTTP API :8088<br/>inputs: FMS, Live Captions,<br/>Alliance Cam, PTZ, NDI"]:::third
        COMP["Bitfocus Companion<br/>:8000 HTTP + tRPC ws"]:::third
        FFMPEG["vMix's ffmpeg6.exe"]:::third
        DECK["Stream Deck"]:::third
    end

    subgraph FIELD["Field network 10.0.100.0/24"]
        FMS["FRC FMS 10.0.100.5<br/>SignalR hubs + REST /api/v1.0"]:::field
        FMSAD["FMS audience display page<br/>BitFocusService"]:::field
        FAKE["fake-fms (dev stand-in)"]:::field
    end

    subgraph FTCNET["FTC event network"]
        SK["FTC Live scorekeeper<br/>ws /api/v2/stream/<br/>REST /api/v1"]:::field
        FTCAV["ftc-vmix-autoav.exe<br/>Node via nexe, run by hand"]:::ftc
    end

    subgraph AVLAN["AV LAN 192.168.25.0/24"]
        SW["switch"]:::third
        PTZ["PTZ 1 / PTZ 2"]:::third
        XAIR["X-Air mixer"]:::third
    end

    subgraph CLOUD["Internet"]
        ADMIN["fim-admin AssistantHub<br/>SignalR"]:::cloud
        GH["GitHub releases"]:::cloud
        YT["YouTube<br/>Studio upload · caption ingest"]:::cloud
        TBA["The Blue Alliance<br/>trusted API"]:::cloud
        GSTT["Google Speech-to-Text"]:::cloud
        LCCLOUD["live-captions cloud-server"]:::cloud
        NC["Nextcloud WebDAV<br/>FMS log archive"]:::cloud
    end

    FIMAV -->|"start / stop / update"| SPAWNED
    AUTOAV -->|"infrastructureHub<br/>GetEventInfo, results"| FMS
    AUTOAV -->|"record start/stop,<br/>inputs, stream keys"| VMIX
    AUTOAV -->|"cut dead time"| FFMPEG
    AUTOAV <-->|"shared manifest<br/>+ .lock"| YTU
    HWPING -.->|"ICMP"| AVLAN
    BFMOD -->|"export + tRPC ws"| COMP
    BFMOD -->|"GetAudienceDisplayConfigs<br/>SaveAudienceDisplayConfig"| FMS
    BFMOD -->|"/api/companion/config"| CAD
    FIMAV -->|"AppInfo, logs, alerts, events"| ADMIN
    FIMAV -->|"youtubeCaptions.setUrl"| LC

    VMIX -->|"browser input :3000"| LC
    VMIX -->|"browser input :3001/display"| CAD
    VMIX -->|"browser input (in-season)"| FMSAD
    VMIX -->|"NDI / SDI"| PTZ
    DECK --> COMP
    COMP -->|"vMix module"| VMIX
    COMP -->|"OSC"| XAIR

    CAD -->|"3 SignalR hubs + REST"| FMS
    CAD -->|"button press + custom variables"| COMP
    CAD -->|"config.set display.position"| LC
    CAD -->|"ensure FMS input,<br/>Alliance Cam composite"| VMIX
    CAD -->|"gzip NDJSON"| NC
    FMSAD -->|"button press"| COMP
    FMSAD --> FMS
    FAKE -.->|"same wire as FMS"| FMS

    LC -->|"audio → text"| GSTT
    LC -->|"captions POST"| YT
    LC -->|"ensure Live Captions input"| VMIX
    LC -.->|"optional fleet config"| LCCLOUD
    YTU -->|"headless Chrome → Studio"| YT
    YTU -->|"match video links"| TBA
    YTU -->|"scores"| FMS

    GH -->|"live-captions, uploader,<br/>audience-display, FIM-AV itself"| FIMAV

    FTCMOD -->|"match + display events"| SK
    FTCMOD -->|"button press per trigger"| COMP
    FTCMOD -->|"record start/stop"| VMIX
    YTU -->|"FTC scores"| SK
    YTU -.->|"match video links (TOA)"| TOA["The Orange Alliance"]:::cloud
    FTCAV -.->|"SHOW_PREVIEW / SHOW_MATCH"| SK
    FTCAV -.->|"QuickPlay input per field"| VMIX
```

## Components

| Component | Repo | Runtime | Ships as | Listens | Talks to |
|---|---|---|---|---|---|
| FIM-AV Assistant | FIRSTinMI/fimav-assistant | Electron 23 | NSIS installer, electron-updater from GitHub | 7780 (status API) | FMS, vMix, Companion, fim-admin, the three exes below |
| AutoAV (in FIM-AV) | same | in-process | | | FMS infrastructureHub + REST, vMix API, ffmpeg, `fimav-matches.json` |
| Bitfocus module (in FIM-AV) | same | in-process | | | Companion `/int/export/full` + `ws /trpc`, FMS audience config, custom AD config |
| live-captions | Filip-Kin/live-captions (releases FIM-AV downloads) | Node 22 via pkg | single exe, auto-update from GitHub | 3000 (overlay `/`, `settings.html`, tRPC http+ws) | Google STT, YouTube caption ingest, vMix (adds "Live Captions" input, overlay 8), optional cloud-server |
| youtube-tba-upload | Filip-Kin/youtube-tba-upload | Go | single exe, pulled by FIM-AV | 8807 | YouTube Studio (bundled Chrome), TBA trusted API, FMS results, shared manifest |
| audience-display | Filip-Kin/audience-display | Bun compiled | single exe with embedded UI, pulled by FIM-AV (own auto-update off) | 3001 (`/` operator, `/display`, `/bitfocus`, `/api/*`, `/ws`) | FMS 3 hubs + REST, vMix, Companion, live-captions position, Nextcloud log sync |
| FMS audience display page | FIRST (decompiled) | FMS web app | part of FMS | | Companion presses per BitfocusStateTypes; config stored by FMS |
| FRC FMS | FIRST | .NET | field PC | 80 (SignalR + REST) | |
| fake-fms | Filip-Kin/fake-fms | Bun | Docker at 10.0.100.5 on a test network | 80, 3010 control | stands in for FMS |
| Bitfocus Companion | Bitfocus | Electron | installed app | 8000 | vMix, X-Air, Stream Deck |
| vMix | StudioCoast | native | installed app | 8088 API, 8099 TCP | cameras, NDI, streams |
| FTC module (in FIM-AV) | same | in-process | | | FTC Live stream + REST, Companion presses, vMix recording, ffmpeg |
| ftc-vmix-autoav | FIRSTinMI/ftc-vmix-autoav | Node 14 via nexe | single exe, run by hand in a console | none | FTC Live scorekeeper ws, vMix QuickPlay |
| FTC Live scorekeeper | FIRST | Java | scorekeeping PC | 80, 28080 or 8080 (ws `/api/v2/stream/?code=`, REST `/api/v1`) | |

## FRC or FTC, in-season or off-season

The program comes from what answers: the FTC scorekeeper answering and FMS not means FTC, FMS
answering means FRC, neither keeps the last value. Settings can force either. In FTC mode only
FTC things show: Bitfocus triggers come from the scorekeeper, the vMix tab adds FTC Live's
audience display, Upload links videos on The Orange Alliance.

The season comes from the event. FRC: fim-admin's event `isOfficial`. FTC: FTC Live's event type
("Non-Advancement" and scrimmages are off-season). No answer = the stored fallback.

| | FRC in-season | FRC off-season | FTC (either season) |
|---|---|---|---|
| File names | short (`QM5_<code>.mp4`) | readable | readable or short by season |
| Audience display | FMS | FMS or custom (Settings) | FTC Live's |
| Dead-time cutting | no | optional | always (match + score reveal) |
| YouTube uploader | no | yes | yes |

A new event (a different `program:code` from FMS or the scorekeeper, whichever is active) refills
the event name and puts the FRC audience display back to FMS (`AutoAV.noteEvent`).

## FTC recording

FTC Live sends no match-end event. FIM-AV records from Match Start until that match's scores post
plus 16 s, or longer while another match still needs recording (stops 10 minutes after a match
with no post). Each match's video is cut from the raw vMix files: the match (start to start +
match length + tail) and its score reveal (post to post + 16 s). When the next match starts
before the scores post, one raw file keeps running and the late reveal is cut out of it; a post
after recording stopped records a short clip for the reveal. Raw files and the timeline live in
`<event folder>/Originals`. An aborted match keeps its footage there and gets no video of its
own: the replay is the match.

## Runtimes shipped to a cart

| Runtime | Carried by | Approx. size |
|---|---|---|
| Chromium + Node (Electron) | FIM-AV Assistant, Companion | 2 copies |
| Node 22 (pkg) | live-captions | 1 |
| Bun | audience-display | 1 |
| Node 14 (nexe) | ftc-vmix-autoav | 1 |
| none | youtube-tba-upload (Go), vMix, ffmpeg (vMix's own) | |

Each program also runs on its own outside FIM, which is why each carries its runtime.

## Open directions (not built)

- **One runtime:** stop shipping Node/Bun inside every exe when FIM-AV runs them; keep the
  standalone exes for people outside FIM.
- **Native tabs:** replace the live-captions and audience-display iframes with FIM-AV's own UI
  over their existing APIs (live-captions tRPC; audience-display `/api/*` + `/ws`).

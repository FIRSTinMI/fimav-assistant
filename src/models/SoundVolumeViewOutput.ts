type SoundVolumeViewOutput = {
    Name: string;
    Type: string;
    Direction: 'Capture' | 'Render' | '';
    'Device Name': string;
    Default: 'Render' | 'Capture' | '';
    'Default Multimedia': string;
    'Default Communications': string;
    'Device State': string;
    Muted: string;
    'Volume dB': string;
    'Volume Percent': string;
    'Min Volume dB': string;
    'Max Volume dB': string;
    'Volume Step': string;
    'Channels Count': string;
    'Channels dB': string;
    'Channels  Percent': string;
    'Item ID': string;
    'Command-Line Friendly ID': string;
    'Process Path': string;
    'Process ID': string;
    'Window Title': string;
    'Registry Key': string;
    'Speakers Config': string;
};

export type ParsedSoundOutput = {
    name: string;
    sub_name: string;
    id: string | number;
    type: string;
    device_type: 'Capture' | 'Render' | 'Application';
    volume_percent: string;
    default: 'Render' | 'Capture' | '';
    muted: boolean;
    control_id: string;
    registry_key: string;
};

export default SoundVolumeViewOutput;

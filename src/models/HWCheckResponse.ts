export default interface HWCheckResponse {
    audio_ready: boolean;
    venue_ip_ready: boolean;
    field_ip_ready: boolean;
    av_ip_ready: boolean;
    unofficial_hw: boolean;
    field_nic_used: 'Unknown' | 'VLAN' | 'Secondary';
    cart_number: number;
    errors: string[];
    logs: string[];
    nics_found: string[];
    audio_devices_found: AudioDeviceStatus[];
    device_statuses: {
        mixer: boolean;
        switch: boolean;
        ptz1: boolean;
        ptz2: boolean;
    };
    static_venue_ip: StaticIpInfo;
}

export interface StaticIpInfo {
    static: boolean;
    ip: string;
    interface: string;
}

export interface AudioDeviceStatus {
    name: string;
    sub_name: string;
    id: string | number;
    type: string;
    device_type: 'Capture' | 'Render' | '';
    volume_percent: string;
    default: 'Render' | 'Capture' | '';
    muted: boolean;
    control_id: string;
    registry_key: string;
}

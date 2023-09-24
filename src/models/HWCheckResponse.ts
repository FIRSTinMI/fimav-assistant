export default interface HWCheckResponse {
    audio_ready: boolean,
    venue_ip_ready: boolean,
    field_ip_ready: boolean,
    av_ip_ready: boolean,
    unofficial_hw: boolean,
    field_nic_used: "Unknown" | "VLAN" | "Secondary"
    cart_number: number,
    errors: string[],
    nics_found: string[],
    audio_devices_found: {name: string, id: string|number, type: string, volume_percent: string}[],
}
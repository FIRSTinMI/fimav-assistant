export default interface HWCheckResponse {
    ip_ready: boolean;
    audio_ready: boolean;
    network_ready: boolean;
    venue_static_ip?: string;
    av_static_ip?: string;
    unofficial_hw: boolean;
}
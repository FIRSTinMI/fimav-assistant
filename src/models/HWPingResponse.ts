export interface IpConfigState {
    errors: string[];
    warnings: string[];
}

export default interface HWPingResponse {
    camera1: boolean;
    camera2: boolean;
    mixer: boolean;
    switch: boolean;
    internet: boolean;
    errors: string[];
    ip_errors: string[];
    ip_warnings: string[];
}

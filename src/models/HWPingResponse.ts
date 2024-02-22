export default interface HWPingResponse {
    camera1: boolean;
    camera2: boolean;
    mixer: boolean;
    switch: boolean;
    errors: string[];
}
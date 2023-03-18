import HWCheckResponse from "models/HWCheckResponse";
import { networkInterfaces, hostname } from "os";



export default function HWCheck(): HWCheckResponse {
    const whoAmI = hostname();
    const interfaces = networkInterfaces();
    const interfaceNames = Object.keys(interfaces).filter(i => i.toLowerCase().indexOf("vlan") > -1);
    // TODO: This is broke
    const ipReady = Object.values(interfaces).filter(i => Array.isArray(i) && i);

    return {
        ip_ready: true,
        audio_ready: true,
        network_ready: interfaceNames.length > 0,
    };
}
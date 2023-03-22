import HWCheckResponse from "models/HWCheckResponse";
import { networkInterfaces, hostname } from "os";



export default function HWCheck(): HWCheckResponse {
    // Get Computer Name
    const whoAmI = hostname();
    // AV Carts are maned FIMAV<number>, so lets determine which cart we are
    let cartNumber = parseInt(whoAmI.replace("FIMAV", ""));
    // If NaN, we are not an AV Cart
    const isAVCart = !isNaN(cartNumber);
    // Set cart number to 1 is NaN
    if (!isAVCart) cartNumber = 1;
    // Get Network Interfaces
    const interfaces = networkInterfaces();
    // Find important interfaces
    const vlan10 = interfaces["Vlan10 - Internet"];
    const vlan20 = interfaces["Vlan20 - Field"];
    const vlan30 = interfaces["Vlan30 - AV"];
    // Check that AV Vlan has a static IP of 192.168.25.<cart_number>0
    const avIp = vlan30?.find((i) => i.family === "IPv4")?.address;
    const avStatic = avIp === `192.168.25.${cartNumber}0`;
    


    return {
        ip_ready: true,
        audio_ready: true,
        network_ready: interfaceNames.length > 0,
        not_official_hw: !isAVCart
    };
}
import { spawn } from "child_process";
import HWCheckResponse from "models/HWCheckResponse";
import SoundVolumeViewOutput from "models/SoundVolumeViewOutput";
import { networkInterfaces, hostname, NetworkInterfaceInfo } from "os";
import path from "path";
import SysInfo from "systeminformation";

const SoundVolumeViewPath = process.env.NODE_ENV === 'production'
    ? path.join(process.resourcesPath, 'assets/SoundVolumeView/SoundVolumeView.exe')
    : path.join(__dirname, '../../../assets/SoundVolumeView/SoundVolumeView.exe');

export default function HWCheck(): HWCheckResponse {
    // The response
    const resp: HWCheckResponse = {
        audio_ready: false,
        av_ip_ready: false,
        venue_ip_ready: false,
        field_ip_ready: false,
        unofficial_hw: false,
        field_nic_used: "Unknown", // or "VLAN" or "Secondary"
        cart_number: -1,
        errors: [],
        nics_found: [],
        audio_devices_found: [],
    }

    // Get Computer Name
    const whoAmI = hostname();

    // AV Carts are maned FIMAV<number>, so lets determine which cart we are
    let cartNumber = parseInt(whoAmI.replace("fimvideo", ""));

    // If NaN, we are not an AV Cart
    const isAVCart = !isNaN(cartNumber);

    // Set cart number to 1 is NaN
    if (!isAVCart) cartNumber = 1;

    // Get Network Interfaces
    const interfaces = networkInterfaces();
    let vlan10: NetworkInterfaceInfo[] | undefined;
    let vlan20: NetworkInterfaceInfo[] | undefined;
    let vlan30: NetworkInterfaceInfo[] | undefined;
    let primaryNic: NetworkInterfaceInfo[] | undefined;
    let secondaryNic: NetworkInterfaceInfo[] | undefined;
    let foundCount = 0;

    // Send nics to response
    resp.nics_found = Object.keys(interfaces);

    // Find important interfaces
    Object.keys(interfaces).forEach(key => {
        if (key === "Ethernet") {
            primaryNic = interfaces[key];
            foundCount++;
        } else if (key === "Ethernet 2") {
            secondaryNic = interfaces[key];
            foundCount++;
        } else if (key.toLowerCase().indexOf("vlan") > -1) {
            if (key.indexOf("10") > -1) {
                vlan10 = interfaces[key];
                foundCount++;
            } else if (key.indexOf("20") > -1) {
                vlan20 = interfaces[key];
                foundCount++;
            } else if (key.indexOf("30") > -1) {
                vlan30 = interfaces[key];
                foundCount++;
            }
        }
    });

    // Check that we found all the required NICs
    if (foundCount < 5) resp.errors.push("Could not find all required network interfaces. Please contact FIMAV Support");

    // Check that AV Vlan has a static IP of 192.168.25.<cart_number>0
    const avIp = vlan30?.find((i) => i.family === "IPv4")?.address;
    resp.av_ip_ready = avIp === `192.168.25.${cartNumber}0`;
    if (!resp.av_ip_ready) resp.errors.push(`AV VLAN IP is incorrectly set to ${avIp}. Should be set statically to 192.168.25.${cartNumber}0, subnet mask of 255.255.255.0, and with no gateway`);

    // Check that Venue Vlan has an IP that doesn't start with 169.254
    const venueIp = vlan10?.find((i) => i.family === "IPv4")?.address;
    resp.venue_ip_ready = venueIp !== undefined && !venueIp.startsWith("169.254");
    if (!resp.venue_ip_ready) resp.errors.push(`No IP from venue! Internet will probably not work (IP: ${venueIp})`);

    // Determine which interface the Field Network is plugged into
    const fieldIpVlan = vlan20?.find((i) => i.family === "IPv4")?.address;
    const fieldIpSecondary = secondaryNic?.find((i) => i.family === "IPv4")?.address;
    if (fieldIpVlan !== undefined && fieldIpVlan.startsWith("10.0.100.")) {
        resp.field_ip_ready = true;
        resp.field_nic_used = "VLAN";
    } else if (fieldIpSecondary !== undefined && fieldIpSecondary.startsWith("10.0.100.")) {
        resp.field_ip_ready = true;
        resp.field_nic_used = "Secondary";
    } else {
        resp.field_ip_ready = false;
        resp.field_nic_used = "Unknown";
        resp.errors.push("Could not find Field Network IP.  Please ensure the field network is plugged into either port 7 on the switch or the secondary NIC of the motherboard.");
    }

    // Check audio devices
    getAudioDevices().then((audio) => {
        console.log(audio);

        resp.audio_devices_found = audio.map((a) => ({
            name: a.Name,
            id: a["Item ID"],
            type: a.Type,
            volume_percent: a["Channels Percent"],
        }));

    }).catch((err) => {
        resp.errors.push(`Could not get audio devices: ${err}`);
    });


    resp.cart_number = cartNumber;

    console.log(resp);

    return resp;
}

async function getAudioDevices(): Promise<SoundVolumeViewOutput[]> {
    return new Promise((resolve, reject) => {
        // Run .\SoundVolumeView.exe /Sjson
        const proc = spawn(SoundVolumeViewPath, ["/Sjson"])
        let buffer = Buffer.from("");
        proc.stdout?.on("data", (data) => {
            buffer = Buffer.concat([buffer, data])
        });

        proc.on("exit", () => {
            // Trim buffer untill the first [ character
            while (buffer[0] !== 91) {
                buffer = buffer.slice(1);
            }

            // Trim end of buffer untill the last ] character
            while (buffer[buffer.length - 1] !== 93) {
                buffer = buffer.slice(0, buffer.length - 1);
            }
            
            try{
                resolve(JSON.parse(buffer.toString()));
            } catch (err) {
                console.log("Error Parsing JSON: ", err, '\n\n\n', buffer.toString());
                resolve([]);
            }
        });
    });
}
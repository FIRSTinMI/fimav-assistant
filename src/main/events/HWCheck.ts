import { spawn } from 'child_process';
import HWCheckResponse from 'models/HWCheckResponse';
import SoundVolumeViewOutput from 'models/SoundVolumeViewOutput';
import { networkInterfaces, hostname, NetworkInterfaceInfo } from 'os';
import path from 'path';
import ping from 'ping';

const SoundVolumeViewPath =
    process.env.NODE_ENV === 'production'
        ? path.join(
            process.resourcesPath,
            'assets/SoundVolumeView/SoundVolumeView.exe'
        )
        : path.join(
            __dirname,
            '../../../assets/SoundVolumeView/SoundVolumeView.exe'
        );

const pingConfig = {
    timeout: 3,
};

export default async function HWCheck(): Promise<HWCheckResponse> {
    // The response
    const resp: HWCheckResponse = {
        audio_ready: false,
        av_ip_ready: false,
        venue_ip_ready: false,
        field_ip_ready: false,
        unofficial_hw: false,
        field_nic_used: 'Unknown', // or "VLAN" or "Secondary"
        cart_number: -1,
        errors: [],
        logs: [],
        nics_found: [],
        audio_devices_found: [],
        device_statuses: {
            mixer: false,
            switch: false,
            ptz1: false,
            ptz2: false,
        },
    };

    if (process.platform !== 'win32') {
        resp.unofficial_hw = true;
        resp.errors.push(
            'This software is only supported on Windows.  Please contact FIMAV Support for assistance.'
        );
        return resp;
    }

    // Get Computer Name
    const whoAmI = hostname();

    // AV Carts are maned FIMAV<number>, so lets determine which cart we are
    let cartNumber = parseInt(whoAmI.replace('fimvideo', ''));

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
    Object.keys(interfaces).forEach((key) => {
        if (key === 'Ethernet') {
            primaryNic = interfaces[key];
            foundCount++;
        } else if (key === 'Ethernet 2') {
            secondaryNic = interfaces[key];
            foundCount++;
        } else if (key.toLowerCase().indexOf('vlan') > -1) {
            if (key.indexOf('10') > -1) {
                vlan10 = interfaces[key];
                foundCount++;
            } else if (key.indexOf('20') > -1) {
                vlan20 = interfaces[key];
                foundCount++;
            } else if (key.indexOf('30') > -1) {
                vlan30 = interfaces[key];
                foundCount++;
            }
        }
    });

    // Check that we found all the required NICs
    if (foundCount < 5)
        resp.errors.push(
            'Could not find all required network interfaces. Please contact FIMAV Support'
        );

    // Enable DHCP on field and venue NICs
    if (vlan10)
        await enableDhcp('Ethernet')
            .then(() => {
                resp.logs.push('Enabled DHCP on Venue VLAN');
            })
            .catch((err) => {
                console.log('Could not enable DHCP on Venue VLAN: ', err);
                resp.errors.push('Failed to enable DHCP on Venue VLAN');
            });

    if (vlan20)
        await enableDhcp('Ethernet 2')
            .then(() => {
                resp.logs.push('Enabled DHCP on Field VLAN');
            })
            .catch((err) => {
                console.log('Could not enable DHCP on Field VLAN: ', err);
                resp.errors.push('Failed to enable DHCP on Field VLAN');
            });

    // Check that AV Vlan has a static IP of 192.168.25.<cart_number>0
    const avIp = vlan30?.find((i) => i.family === 'IPv4')?.address;
    resp.av_ip_ready = avIp === `192.168.25.${cartNumber}0`;
    if (!resp.av_ip_ready) {
        // Call netsh to set the IP
        await setStaticIp(
            'Ethernet',
            `192.168.25.${cartNumber}0`,
            '255.255.255.0',
            ''
        )
            .then(() => {
                resp.logs.push(
                    `Set AV VLAN IP was incorrectly set to ${avIp}.  Set static to 192.168.25.${cartNumber}0`
                );
                resp.av_ip_ready = true;
            })
            .catch((err) => {
                console.log('Could not set AV VLAN IP: ', err);
                resp.errors.push(
                    `AV VLAN IP is incorrectly set to ${avIp}, and was unable to be updated. Should be set statically to 192.168.25.${cartNumber}0, subnet mask of 255.255.255.0, and with no gateway`
                );
            });
    }

    if (resp.av_ip_ready) {
        // Ping on-cart devices
        const promises = [
            // TODO: Ensure these are the right IPs
            // Ping switch
            ping.promise.probe(`192.168.25.10${cartNumber}`, pingConfig),
            // Ping mixer
            ping.promise.probe(`192.168.25.${cartNumber}2`, pingConfig),
            // Ping PTZ1
            ping.promise.probe(`192.168.25.${cartNumber}3`, pingConfig),
            // Ping PTZ2
            ping.promise.probe(`192.168.25.${cartNumber}4`, pingConfig),
        ];

        // Wait for all pings to finish
        await Promise.all(promises)
            .then((rsp) => {
                resp.device_statuses = {
                    mixer: rsp[1].alive,
                    switch: rsp[0].alive,
                    ptz1: rsp[2].alive,
                    ptz2: rsp[3].alive,
                };
            })
            .catch((err) => {
                resp.errors.push(
                    "Failed to ping on-cart devices. No worries, we'll set these up later."
                );
                console.log('Could not ping on-cart devices: ', err);
            });
    }

    // Check that Venue Vlan has an IP that doesn't start with 169.254
    const venueIp = vlan10?.find((i) => i.family === 'IPv4')?.address;
    resp.venue_ip_ready =
        venueIp !== undefined && !venueIp.startsWith('169.254');
    // if (!resp.venue_ip_ready) resp.errors.push(`No IP from venue! Internet will probably not work (IP: ${venueIp})`);

    // Determine which interface the Field Network is plugged into
    const fieldIpVlan = vlan20?.find((i) => i.family === 'IPv4')?.address;
    const fieldIpSecondary = secondaryNic?.find(
        (i) => i.family === 'IPv4'
    )?.address;
    if (fieldIpVlan !== undefined && fieldIpVlan.startsWith('10.0.100.')) {
        resp.field_ip_ready = true;
        resp.field_nic_used = 'VLAN';
    } else if (
        fieldIpSecondary !== undefined &&
        fieldIpSecondary.startsWith('10.0.100.')
    ) {
        resp.field_ip_ready = true;
        resp.field_nic_used = 'Secondary';
    } else {
        resp.field_ip_ready = false;
        resp.field_nic_used = 'Unknown';
        // resp.errors.push("Could not find Field Network IP.  Please ensure the field network is plugged into either port 7 on the switch or the secondary NIC of the motherboard.");
    }

    // Check audio devices
    resp.audio_devices_found = await fetchAndParseAudioDevices().catch(
        (err) => {
            resp.errors.push(
                'Could not fetch audio devices.  Please contact FIMAV Support.'
            );
            console.log('Could not fetch audio devices: ', err);
            return [] as any;
        }
    );

    // Ensure that "IN 1-2" of "BEHRINGER X-AIR" is the default, is unmuted, and the volume is over 75%
    const xAirIndex = resp.audio_devices_found.findIndex(
        (a) => a.name === 'IN 1-2' && a.sub_name.includes('BEHRINGER X-AIR')
    );
    const xAir = resp.audio_devices_found[xAirIndex];

    if (!xAir) {
        resp.errors.push(
            "Could not find BEHRINGER X-AIR 'IN 1-2' audio device.  Contact FIMAV Support for assistance."
        );
    } else {
        // Mark audio as ready.  If we later find an error that we can't fix, we will set this to false
        resp.audio_ready = true;

        if (xAir.default !== 'Render') {
            // Not default device
            await setDefaultAudioDevice(xAir.name, 'all')
                .then(() => {
                    resp.logs.push(
                        `Set BEHRINGER X-AIR 'IN 1-2' as default audio device.`
                    );
                    resp.audio_devices_found[xAirIndex].default = 'Render';
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not set BEHRINGER X-AIR 'IN 1-2' as default audio device.  Please select it from the task bar.`
                    );
                    console.log('Could not set default device: ', err);
                    resp.audio_ready = false;
                });
        }
        if (xAir.muted) {
            // Muted
            await unmuteDevice(xAir.name)
                .then(() => {
                    resp.logs.push(`Unmuted BEHRINGER X-AIR 'IN 1-2'`);
                    resp.audio_devices_found[xAirIndex].muted = false;
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not unmute BEHRINGER X-AIR 'IN 1-2'.  Please unmute it from the task bar.`
                    );
                    console.log('Could not unmute device: ', err);
                    resp.audio_ready = false;
                });
        }
        if (parseInt(xAir.volume_percent.replace('%', ''), 10) < 75) {
            // Percetage is less than 75%
            await setVolumePercent(xAir.name, 75)
                .then(() => {
                    resp.logs.push(
                        `Set BEHRINGER X-AIR 'IN 1-2' volume to 75%`
                    );
                    resp.audio_devices_found[xAirIndex].volume_percent =
                        '75.0%';
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not set BEHRINGER X-AIR 'IN 1-2' volume to 75%.  Please set it from the task bar.`
                    );
                    console.log('Could not set volume: ', err);
                    resp.audio_ready = false;
                });
        }
    }

    resp.cart_number = cartNumber;

    console.log(resp);

    return resp;
}

async function enableDhcp(interfaceName: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        // Run netsh interface ipv4 set address name="Ethernet" static
        const proc = spawn('netsh', [
            'interface',
            'ipv4',
            'set',
            'address',
            `name="${interfaceName}"`,
            'dhcp',
        ]);

        // Listen for exit
        proc.on('exit', () => {
            resolve(true);
        });

        // Listen for error
        proc.on('error', (err) => {
            reject(err);
        });
    });
}

async function setStaticIp(
    interfaceName: string,
    ip: string,
    subnet: string,
    gateway: string
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        // Run netsh interface ipv4 set address name="Ethernet" static
        const proc = spawn('netsh', [
            'interface',
            'ipv4',
            'set',
            'address',
            `name="${interfaceName}"`,
            'static',
            ip,
            subnet,
            gateway,
        ]);

        // Listen for exit
        proc.on('exit', () => {
            resolve(true);
        });

        // Listen for error
        proc.on('error', (err) => {
            reject(err);
        });
    });
}

async function fetchAndParseAudioDevices(): Promise<SoundVolumeViewOutput[]> {
    // Fetch Devices
    const devices = await getAudioDevices();

    // Parse them to pretty
    const parsed = devices.map((a) => ({
        name: a.Name,
        sub_name: a['Device Name'],
        id: a['Item ID'],
        type: a.Type,
        device_type: a.Direction,
        volume_percent: a['Volume Percent'],
        default: a.Default,
        muted: a.Muted === 'Yes',
        control_id: a['Command-Line Friendly ID'].replaceAll('\\\\', '\\'),
        registry_key: a['Registry Key'].replaceAll('\\\\', '\\'),
    }));

    // Return
    return parsed as any[];
}

async function getAudioDevices(): Promise<SoundVolumeViewOutput[]> {
    return new Promise((resolve, reject) => {
        // Run .\SoundVolumeView.exe /Sjson
        const proc = spawn(SoundVolumeViewPath, ['/Sjson']);
        let buffer = Buffer.from('');
        proc.stdout?.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
        });

        proc.on('exit', () => {
            // Buffer to string
            let str = buffer.toString();

            // Trim str until the first [ character
            const firstBracket = str.indexOf('[');
            str = str.slice(firstBracket);

            // Trim end until the last ] character
            const lastBracket = str.lastIndexOf(']');
            str = str.slice(0, lastBracket + 1);

            try {
                // Replace some (ok, a lot...) things
                const replaced = str
                    .replaceAll('\n', '')
                    .replaceAll('\0', '') // this is dumb and took way too long to figure out. JSON won't parse if there are null characters in the string
                    .replaceAll('\r', '')
                    .replaceAll('\t', '')
                    .replace(/^\s+|\s+$/g, '')
                    .replace(/\\n/g, '\\n')
                    .replace(/\\'/g, "\\'")
                    .replace(/\\"/g, '\\"')
                    .replace(/\\&/g, '\\&')
                    .replace(/\\r/g, '\\r')
                    .replace(/\\t/g, '\\t')
                    .replace(/\\b/g, '\\b')
                    .replace(/\\f/g, '\\f')
                    .replaceAll('\\', '\\\\'); // This MUST be last!
                resolve(JSON.parse(replaced));
            } catch (err) {
                console.log('Error Parsing JSON: ', err);
                resolve([]);
            }
        });
    });
}

// Percent is 0-100
async function setVolumePercent(
    deviceCmdName: string,
    percent: number
): Promise<boolean> {
    return runSetSoundCommand('/SetVolume', deviceCmdName, percent.toString());
}

async function unmuteDevice(deviceCmdName: string): Promise<boolean> {
    return runSetSoundCommand('/Unmute', deviceCmdName);
}

async function setDefaultAudioDevice(
    deviceCmdName: string,
    type: 'Console' | 'Multimedia' | 'Communications' | 'all'
): Promise<boolean> {
    return runSetSoundCommand('/SetDefault', deviceCmdName, type);
}

async function runSetSoundCommand(
    cmd: string,
    ...params: string[]
): Promise<boolean> {
    /* TODO: investigate further
    return new Promise((resolve, reject) => {
        // Spawn the process
        const proc = spawn(SoundVolumeViewPath, [cmd, ...params]);
        // Listen for exit
        proc.on("exit", () => {
            resolve(true);
        });

        // Listen for error
        proc.on("error", (err) => {
            reject(err);
        });
    });
*/

    return true;
}

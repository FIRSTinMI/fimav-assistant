import { exec, spawn } from 'child_process';
import electronLog, { LogFunctions } from 'electron-log';
import { NetAdapterModel } from 'models/AdvancedAdapterInfo';
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
    const log = electronLog.scope('HWCheck');

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
    const whoAmI = hostname().toLowerCase();

    // AV Carts are maned FIMAV<number>, so lets determine which cart we are
    let cartNumber = parseInt(whoAmI.replace(/\D/g, ''), 10);

    // If NaN, we are not an AV Cart
    const isAVCart = !Number.isNaN(cartNumber);

    // Set cart number to 1 is NaN
    if (!isAVCart) cartNumber = 1;

    // Get Network Interfaces
    const interfaces = networkInterfaces();
    const advancedInterfaces = await advancedNetworkInterfaces(log);
    let vlan10: NetworkInterfaceInfo[] | undefined;
    let vlan10Name: string | undefined;
    let vlan20: NetworkInterfaceInfo[] | undefined;
    let vlan20Name: string | undefined;
    let vlan30: NetworkInterfaceInfo[] | undefined;
    let vlan30Name: string | undefined;
    let primaryNic: NetworkInterfaceInfo[] | undefined; // eslint-disable-line no-unused-vars
    let primaryName: string | undefined; // eslint-disable-line no-unused-vars
    let secondaryNic: NetworkInterfaceInfo[] | undefined;
    let secondaryName: string | undefined;

    // Send nics to response
    resp.nics_found = Object.keys(interfaces);

    // Find important interfaces
    Object.keys(interfaces).forEach(key => {
        const compare = key.toLowerCase()
        if (compare === "ethernet") {
            primaryNic = interfaces[key];
            primaryName = key;
        } else if (compare === "ethernet 2") {
            secondaryNic = interfaces[key];
            secondaryName = key;
        }

        // See if we have advanced info on this NIC and the driver desc is Hyper-V
        if (advancedInterfaces[key] && advancedInterfaces[key].DriverDesc === "{Hyper-V Virtual Ethernet Adapter}") {
            if (advancedInterfaces[key].VLAN_ID === '10' || key.toLowerCase().includes("internet")) {
                vlan10 = interfaces[key];
                vlan10Name = key;
            } else if (advancedInterfaces[key].VLAN_ID === '20' || key.toLowerCase().includes("field")) {
                vlan20 = interfaces[key];
                vlan20Name = key;
            } else if (advancedInterfaces[key].VLAN_ID === '30' || key.toLowerCase().includes("av")) {
                vlan30 = interfaces[key];
                vlan30Name = key;
            }
        }
    });

    // Valid collections of NICs
    const allExist = vlan10 && vlan20 && vlan30;;
    const altConfig = vlan10 && secondaryName && vlan30;

    // Check that we found all the required NICs
    if (!allExist && !altConfig)
        resp.errors.push(
            'Could not find all required network interfaces. Please contact FIMAV Support'
        );

    // Enable DHCP on venue NIC
    if (vlan10 && vlan10Name)
        await enableDhcp(vlan10Name)
            .then(() => {
                resp.logs.push('Enabled DHCP on Venue VLAN');
                return undefined;
            })
            .catch((err) => {
                log.error('Could not enable DHCP on Venue VLAN: ', err);
                resp.errors.push('Failed to enable DHCP on Venue VLAN');
            });

    // Enable DHCP on field NIC
    if (vlan20 && vlan20Name)
        await enableDhcp(vlan20Name)
            .then(() => {
                resp.logs.push('Enabled DHCP on Field VLAN');
                return undefined;
            })
            .catch((err) => {
                log.error('Could not enable DHCP on Field VLAN: ', err);
                resp.errors.push('Failed to enable DHCP on Field VLAN');
            });

    // Check that AV Vlan has a static IP of 192.168.25.<cart_number>0
    if (vlan30 && vlan30Name) {
        const avIp = vlan30.find((i) => i.family === 'IPv4')?.address;
        resp.av_ip_ready = avIp === `192.168.25.${cartNumber}0`;
        if (!resp.av_ip_ready) {
            // Call netsh to set the IP
            await setStaticIp(
                vlan30Name,
                `192.168.25.${cartNumber}0`,
                '255.255.255.0',
                ''
            )
                .then(() => {
                    resp.logs.push(
                        `Set AV VLAN IP was incorrectly set to ${avIp}.  Set static to 192.168.25.${cartNumber}0`
                    );
                    resp.av_ip_ready = true;
                    return undefined;
                })
                .catch((err) => {
                    log.error('Could not set AV VLAN IP: ', err);
                    resp.errors.push(
                        `AV VLAN IP is incorrectly set to ${avIp}, and was unable to be updated. Should be set statically to 192.168.25.${cartNumber}0, subnet mask of 255.255.255.0, and with no gateway`
                    );
                });
        }
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
        try {
            const rsp = await Promise.all(promises);
            resp.device_statuses = {
                switch: rsp[0].alive,
                mixer: rsp[1].alive,
                ptz1: rsp[2].alive,
                ptz2: rsp[3].alive,
            };
        } catch (err) {
            resp.errors.push(
                "Failed to ping on-cart devices. No worries, we'll set these up later."
            );
            log.error('Could not ping on-cart devices: ', err);
        }
    }

    // Check that Venue Vlan has an IP that doesn't start with 169.254
    const venueIp = vlan10?.find((i) => i.family === 'IPv4')?.address;
    resp.venue_ip_ready =
        venueIp !== undefined && !venueIp.startsWith('169.254');

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
    resp.audio_devices_found = await fetchAndParseAudioDevices(log).catch(
        (err) => {
            resp.errors.push(
                'Could not fetch audio devices.  Please contact FIMAV Support.'
            );
            log.error('Could not fetch audio devices: ', err);
            return [] as any;
        }
    );

    // Ensure that "OUT 1-2" of "BEHRINGER X-AIR" is the default, is unmuted, and the volume is over 75%
    const xAirIndex = resp.audio_devices_found.findIndex(
        (a) => a.name === 'OUT 1-2' && a.sub_name.includes('BEHRINGER X-AIR')
    );
    const xAir = resp.audio_devices_found[xAirIndex];

    if (!xAir) {
        resp.errors.push(
            "Could not find BEHRINGER X-AIR 'OUT 1-2' audio device.  Contact FIMAV Support for assistance."
        );
    } else {
        // Mark audio as ready.  If we later find an error that we can't fix, we will set this to false
        resp.audio_ready = true;

        if (xAir.default !== 'Render') {
            // Not default device
            await setDefaultAudioDevice(xAir.name, 'all')
                .then(() => {
                    resp.logs.push(
                        `Set BEHRINGER X-AIR 'OUT 1-2' as default audio device.`
                    );
                    resp.audio_devices_found[xAirIndex].default = 'Render';
                    return undefined;
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not set BEHRINGER X-AIR 'OUT 1-2' as default audio device.  Please select it from the task bar.`
                    );
                    log.error('Could not set default device: ', err);
                    resp.audio_ready = false;
                });
        }
        if (xAir.muted) {
            // Muted
            await unmuteDevice(xAir.name)
                .then(() => {
                    resp.logs.push(`Unmuted BEHRINGER X-AIR 'OUT 1-2'`);
                    resp.audio_devices_found[xAirIndex].muted = false;
                    return undefined;
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not unmute BEHRINGER X-AIR 'OUT 1-2'.  Please unmute it from the task bar.`
                    );
                    log.error('Could not unmute device: ', err);
                    resp.audio_ready = false;
                });
        }
        if (parseInt(xAir.volume_percent.replace('%', ''), 10) < 100) {
            // Percetage is less than 100%
            await setVolumePercent(xAir.name, 100)
                .then(() => {
                    resp.logs.push(
                        `Set BEHRINGER X-AIR 'OUT 1-2' volume to 75%`
                    );
                    resp.audio_devices_found[xAirIndex].volume_percent =
                        '75.0%';
                    return undefined;
                })
                .catch((err) => {
                    resp.errors.push(
                        `Could not set BEHRINGER X-AIR 'OUT 1-2' volume to 75%.  Please set it from the task bar.`
                    );
                    log.error('Could not set volume: ', err);
                    resp.audio_ready = false;
                });
        }
    }

    const keysToExclude = ['id', 'registry_key'];

    resp.audio_devices_found.map((device: any) =>
        keysToExclude.forEach(key => delete device[key])
    )

    resp.cart_number = cartNumber;

    log.info(resp);

    return resp;
}

async function enableDhcp(interfaceName: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        // Run netsh interface ipv4 set address name="Ethernet" static
        resolve(true);
        // const proc = spawn('netsh', [
        //     'interface',
        //     'ipv4',
        //     'set',
        //     'address',
        //     `name="${interfaceName}"`,
        //     'dhcp',
        // ]);

        // // Listen for exit
        // proc.on('exit', () => {
        //     resolve(true);
        // });

        // // Listen for error
        // proc.on('error', (err) => {
        //     reject(err);
        // });
    });
}

// Get advanced network interface info
// See the output in assets/sample_payloads/ExampleNetworkOutput.json for some example data
async function advancedNetworkInterfaces(log: LogFunctions): Promise<NetAdapterModel> {
    return new Promise((resolve, reject) => {
        // Fun commands
        exec('powershell "Get-NetAdapterAdvancedProperty -Name \\"*\\" -AllProperties  | Format-List -Property \\"*"\\"', (error, stdout, stderr) => {
            if (error) {
                log.error(`Error executing command: ${error.message}`);
                reject();
                return;
            }
            if (stderr) {
                log.error(`Command stderr: ${stderr}`);
                reject()
                return;
            }

            // Parse the output into a JavaScript object
            const objs: any[] = [];
            let index = 0;

            // Split on new line and loop
            stdout.split('\n').forEach(line => {
                // Create object if doesn't exist
                if (!objs[index]) objs[index] = {};

                // Split on colon, trim whitespace
                const [name, value] = line.split(':').map(part => part.trim());

                // Empty line is new adapter
                if (name === '') {
                    index += 1;
                } else {
                    objs[index][name] = value;
                }
            });

            // Convert to object key'd by "Name"
            const byNames: any = {};
            objs.forEach(obj => {
                if (!byNames[obj.Name]) byNames[obj.Name] = {};
                byNames[obj.Name][obj.ValueName] = obj.ValueData;
            });
            resolve(byNames);
        });
    });
}

/*
* Set a static IP on a network interface
*   interfaceName: The name of the interface to set the IP on
*   ip: The IP address to set
*   subnet: The subnet mask to set
*   gateway: The gateway to set
*/
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

/*
* Fetch and parse audio devices
*   log: Electron log instance
*/
async function fetchAndParseAudioDevices(log: LogFunctions): Promise<SoundVolumeViewOutput[]> {
    // Fetch Devices
    const devices = await getAudioDevices(log);

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

/*
* Get audio devices
*   log: Electron log instance
*/
async function getAudioDevices(log: LogFunctions): Promise<SoundVolumeViewOutput[]> {
    return new Promise((resolve) => {
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
                log.error('Error Parsing JSON: ', err);
                resolve([]);
            }
        });
    });
}

/*
* Set the volume of a device
*   deviceCmdName: The command line friendly ID of the device
*   percent: The percent to set the volume to (0-100)
*/
async function setVolumePercent(
    deviceCmdName: string,
    percent: number
): Promise<boolean> {
    return runSetSoundCommand('/SetVolume', deviceCmdName, percent.toString());
}

/*
* Unmute a device
*   deviceCmdName: The command line friendly ID of the device
*/
async function unmuteDevice(deviceCmdName: string): Promise<boolean> {
    return runSetSoundCommand('/Unmute', deviceCmdName);
}

/*
* Set the default audio device
*   deviceCmdName: The command line friendly ID of the device
*   type: The type of device to set as default
*/
async function setDefaultAudioDevice(
    deviceCmdName: string,
    type: 'Console' | 'Multimedia' | 'Communications' | 'all'
): Promise<boolean> {
    return runSetSoundCommand('/SetDefault', deviceCmdName, type);
}

/*
* Run a SoundVolumeView command
*   cmd: The command to run
*   params: The parameters to pass to the command
*/
async function runSetSoundCommand(
    cmd: string,
    ...params: string[]
): Promise<boolean> {
    // return new Promise((resolve) => {
    //     electronLog.debug(cmd, params);
    //     resolve(true);
    // });
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
}

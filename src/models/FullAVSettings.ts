import { AutoAVSettings } from 'main/addons/autoav';
import { VmixSettings } from 'main/services/VmixService';

type FullAVSettings = {
    autoav: AutoAVSettings,
    vmix: VmixSettings,
}

export default FullAVSettings;

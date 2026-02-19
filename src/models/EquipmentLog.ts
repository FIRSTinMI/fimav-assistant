/* eslint-disable no-shadow */
/* eslint-disable no-unused-vars */
export enum EquipmentLogType {
    Debug = 'Debug',
    Info = 'Info',
    Warn = 'Warn',
    Error = 'Error',
    Fatal = 'Fatal',
}

export enum EquipmentLogCategory {
    General = 'general',
    AutoAV_Recording = 'autoav_recording',
    AutoAV_FMS = 'autoav_fms',
    AutoAV_General = 'autoav_general',
    HWPing_General = 'hwping_general',
    Vmix_General = 'vmix_general',
}

export interface EquipmentLogDetails {
    severity?: EquipmentLogType;
    category: EquipmentLogCategory;
    extraInfo?: object;
}

export = BleAdvertisement;
/**
 * @classdesc
 * This class is a representation of a BLE Advertisement for a {@link BlePeripheral} in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link ManagerBle#discover} or {@link ManagerBle#find}.
 */
declare class BleAdvertisement extends SimpleClass {
    /**
     * Id of the peripheral assigned by Homey
     * @type {string}
     */
    id: string;
    /**
     * Uuid of the peripheral
     * @type {string}
     */
    uuid: string;
    /**
     * The mac address of the peripheral
     * @type {string}
     */
    address: string;
    /**
     * The address type of the peripheral
     * @type {string}
     */
    addressType: string;
    /**
     * Indicates if Homey can connect to the peripheral
     * @type {boolean}
     */
    connectable: boolean;
    /**
     * The local name of the peripheral
     * @type {string}
     */
    localName: string;
    /**
     * Manufacturer specific data for peripheral
     * @type {Buffer}
     */
    manufacturerData: Buffer;
    /**
     * Array of service data entries
     * @type {Array<{uuid: string, data: Buffer}>}
     */
    serviceData: {
        uuid: string;
        data: Buffer;
    }[];
    /**
     * Array of service uuids
     * @type {string[]}
     */
    serviceUuids: string[];
    /**
     * The rssi signal strength value for the peripheral
     * @type {number}
     */
    rssi: number;
    /**
     * Connect to the BLE peripheral this advertisement references
     * @returns {Promise<BlePeripheral>}
     */
    connect(): Promise<BlePeripheral>;
}
import SimpleClass = require("./SimpleClass.js");
import BlePeripheral = require("./BlePeripheral.js");

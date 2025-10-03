export = BlePeripheral;
/**
 * @typedef {object} BlePeripheral.Advertisement
 * @property {string} localName - The local name of the peripheral
 * @property {string} manufacturerData - Manufacturer specific data for peripheral
 * @property {string[]} serviceData - Array of service data entries
 * @property {string[]} serviceUuids - Array of service uuids
 */
/**
 * @classdesc
 * This class is a representation of a BLE peripheral in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link BleAdvertisement#connect}.
 */
declare class BlePeripheral extends SimpleClass {
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
     * @type {string | undefined}
     */
    address: string | undefined;
    /**
     * The address type of the peripheral
     * @type {string | undefined}
     */
    addressType: string | undefined;
    /**
     * Indicates if Homey can connect to the peripheral
     * @type {boolean | undefined}
     */
    connectable: boolean | undefined;
    /**
     * The rssi signal strength value for the peripheral
     * @type {number | undefined}
     */
    rssi: number | undefined;
    /**
     * The state of the peripheral
     * @type {string | undefined}
     */
    state: string | undefined;
    /**
     * Advertisement data of the peripheral
     * @type {import('./BleAdvertisement')}
     */
    advertisement: import('./BleAdvertisement');
    /**
     * Array of services of the peripheral. Note that this array is only filled after the service is discovered by {@link BleAdvertisement#discoverServices} or {@link BleAdvertisement#discoverService}
     * @type {BleService[]}
     */
    services: BleService[];
    /**
     * If the peripheral is currently connected to Homey
     */
    get isConnected(): boolean;
    /**
     * Connects to the peripheral if Homey disconnected from it
     * @returns {Promise<this>}
     */
    connect(): Promise<this>;
    /**
     * Kept for backwards compatibility
     */
    assertConnected(): Promise<BlePeripheral>;
    /**
     * Disconnect Homey from the peripheral
     * @returns {Promise<void>}
     */
    disconnect(): Promise<void>;
    /**
     * Updates the RSSI signal strength value
     * @returns {Promise<string>} rssi
     */
    updateRssi(): Promise<string>;
    /**
     * Discovers the services of the peripheral
     * @param {string[]} [servicesFilter] list of services to discover, if not given all services will be discovered
     * @returns {Promise<BleService[]>}
     */
    discoverServices(servicesFilter?: string[] | undefined): Promise<BleService[]>;
    /**
     * Discovers all services and characteristics of the peripheral
     * @returns {Promise<BleService[]>}
     */
    discoverAllServicesAndCharacteristics(): Promise<BleService[]>;
    /**
     * Get a service with the given uuid
     * @param {string} uuid The uuid of the service
     * @returns {Promise<BleService>}
     */
    getService(uuid: string): Promise<BleService>;
    /**
     * Shorthand to read a characteristic for given serviceUuid and characteristicUuid
     * @param {string} serviceUuid The uuid of the service that has given characteristic
     * @param {string} characteristicUuid The uuid of the characteristic that needs to be read
     * @returns {Promise<Buffer>}
     */
    read(serviceUuid: string, characteristicUuid: string): Promise<Buffer>;
    /**
     * Shorthand to write to a characteristic for given serviceUuid and characteristicUuid
     * @param {string} serviceUuid The uuid of the service that has given characteristic
     * @param {string} characteristicUuid The uuid of the characteristic that needs to be written to
     * @param {Buffer} data The data that needs to be written
     * @returns {Promise<Buffer>}
     */
    write(serviceUuid: string, characteristicUuid: string, data: Buffer): Promise<Buffer>;
}
declare namespace BlePeripheral {
    type Advertisement = {
        /**
         * - The local name of the peripheral
         */
        localName: string;
        /**
         * - Manufacturer specific data for peripheral
         */
        manufacturerData: string;
        /**
         * - Array of service data entries
         */
        serviceData: string[];
        /**
         * - Array of service uuids
         */
        serviceUuids: string[];
    };
}
import SimpleClass = require("./SimpleClass.js");
import BleService = require("./BleService.js");

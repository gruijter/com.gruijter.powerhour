export = BleService;
/**
 * @classdesc
 * This class is a representation of a BLE Advertisement for a {@link BlePeripheral} in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link BlePeripheral#discoverServices} or {@link BlePeripheral#getService}.
 */
declare class BleService extends SimpleClass {
    /**
     * The peripheral object that is the owner of this service
     * @type {import('./BlePeripheral')}
     */
    peripheral: import('./BlePeripheral');
    /**
     * Id of the service assigned by Homey
     * @type {string}
     */
    id: string;
    /**
     * Uuid of the service
     * @type {string}
     */
    uuid: string;
    /**
     * The name of the service
     * @type {string}
     */
    name: string;
    /**
     * The type of the service
     * @type {string}
     */
    type: string;
    /**
     * @type {BleCharacteristic[]}
     */
    characteristics: BleCharacteristic[];
    /**
     * Discover characteristics of this service
     * @param {string[]} [characteristicsFilter] List of characteristicUuids to search for
     * @returns {Promise<BleCharacteristic[]>}
     */
    discoverCharacteristics(characteristicsFilter?: string[] | undefined): Promise<BleCharacteristic[]>;
    /**
     * gets a characteristic for given characteristicUuid
     * @param {string} uuid The characteristicUuid to get
     * @returns {Promise<BleCharacteristic>}
     */
    getCharacteristic(uuid: string): Promise<BleCharacteristic>;
    /**
     * Shorthand to read a characteristic for given characteristicUuid
     * @param {string} characteristicUuid The uuid of the characteristic that needs to be read
     * @returns {Promise<Buffer>}
     */
    read(characteristicUuid: string): Promise<Buffer>;
    /**
     * Shorthand to write to a characteristic for given characteristicUuid
     * @param {string} characteristicUuid The uuid of the characteristic that needs to be written to
     * @param {Buffer} data The data that needs to be written
     * @returns {Promise<Buffer>}
     */
    write(characteristicUuid: string, data: Buffer): Promise<Buffer>;
}
import SimpleClass = require("./SimpleClass.js");
import BleCharacteristic = require("./BleCharacteristic.js");

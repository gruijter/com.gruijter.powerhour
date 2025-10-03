export = BleDescriptor;
/**
 * @classdesc
 * This class is a representation of a BLE Advertisement for a {@link BlePeripheral} in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link BleCharacteristic#discoverDescriptors}.
 */
declare class BleDescriptor extends SimpleClass {
    /**
     * The peripheral object that is the owner of this descriptor
     * @type {import('./BlePeripheral')}
     */
    peripheral: import('./BlePeripheral');
    /**
     * The service object that is the owner of this descriptor
     * @type {import('./BleService')}
     */
    service: import('./BleService');
    /**
     * The characteristic object that is the owner of this descriptor
     * @type {import('./BleCharacteristic')}
     */
    characteristic: import('./BleCharacteristic');
    /**
     * Id of the characteristic assigned by Homey
     * @type {string}
     */
    id: string;
    /**
     * Uuid of the characteristic
     * @type {string}
     */
    uuid: string;
    /**
     * The name of the descriptor
     * @type {string}
     */
    name: string;
    /**
     * The type of the descriptor
     * @type {string}
     */
    type: string;
    /**
     * The value of the descriptor. Note this is set to the last result of ${@link BleDescriptor#read} and is initially null
     * @type {Buffer | null}
     */
    value: Buffer | null;
    /**
     * Read the value for this descriptor
     * @returns {Promise<Buffer>}
     */
    readValue(): Promise<Buffer>;
    /**
     * Write a value to this descriptor
     * @param {Buffer} data The data that should be written
     * @returns {Promise<Buffer>}
     */
    writeValue(data: Buffer): Promise<Buffer>;
}
import SimpleClass = require("./SimpleClass.js");

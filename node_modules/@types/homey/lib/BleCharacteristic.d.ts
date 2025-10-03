export = BleCharacteristic;
/**
 * @classdesc
 * This class is a representation of a BLE Advertisement for a {@link BlePeripheral} in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link BleService#discoverCharacteristics} or {@link BleService#getCharacteristic}.
 */
declare class BleCharacteristic extends SimpleClass {
    /**
     * The peripheral object that is the owner of this characteristic
     * @type {import('./BlePeripheral')}
     */
    peripheral: import('./BlePeripheral');
    /**
     * The service object that is the owner of this characteristic
     * @type {import('./BleService')}
     */
    service: import('./BleService');
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
     * The name of the characteristic
     * @type {string}
     */
    name: string;
    /**
     * The type of the characteristic
     * @type {string}
     */
    type: string;
    /**
     * The properties of the characteristic
     * @type {string[]}
     */
    properties: string[];
    /**
     * The value of the characteristic. Note this is set to the last result of ${@link BleCharacteristic#read} and is initially null
     * @type {Buffer | null}
     */
    value: Buffer | null;
    /**
     * @type {BleDescriptor[]}
     */
    descriptors: BleDescriptor[];
    _callback: BleCharacteristic.NotificationCallback | null;
    /**
     * Discovers descriptors for this characteristic
     * @param {string[]} [descriptorsFilter] list of descriptorUuids to search for
     * @returns {Promise<BleDescriptor[]>}
     */
    discoverDescriptors(descriptorsFilter?: string[] | undefined): Promise<BleDescriptor[]>;
    /**
     * Read the value for this characteristic
     * @returns {Promise<Buffer>}
     */
    read(): Promise<Buffer>;
    /**
     * Write a value to this characteristic
     * @param {Buffer} data The data that should be written
     * @returns {Promise<Buffer>}
     */
    write(data: Buffer): Promise<Buffer>;
    /**
     * @callback BleCharacteristic.NotificationCallback
     * @param {Buffer} data the received notification data
     */
    /**
     * Subscribe to BLE notifications from the characteristic.
     * The callback will be called with the data as buffer
     * @param {BleCharacteristic.NotificationCallback} callback
     * @returns {Promise<void>} - resolves when the subscription is succesful
     * @since 6.0.0
     */
    subscribeToNotifications(callback: BleCharacteristic.NotificationCallback): Promise<void>;
    /**
     * Unsubscribes notifications from this characteristic.
     * @returns {Promise<void>} - resolves when unsubscribe has performed successful and the callback has been removed.
     * @since 6.0.0
     */
    unsubscribeFromNotifications(): Promise<void>;
}
declare namespace BleCharacteristic {
    type NotificationCallback = (data: Buffer) => any;
}
import SimpleClass = require("./SimpleClass.js");
import BleDescriptor = require("./BleDescriptor.js");

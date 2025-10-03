export = Driver;
/**
 * @typedef {import('./Homey')} Homey
 * @typedef {import('./DiscoveryStrategy')} DiscoveryStrategy
 * @typedef {import('./PairSession')} PairSession
 */
/**
 * The Driver class manages all Device instances, which represent all paired devices.
 * This class should be extended and exported from `driver.js`.
 * Methods prefixed with `on` are meant to be overriden.
 * It is not allowed to overwrite the constructor.
 * @example <caption>/drivers/my_driver/driver.js</caption>
 * const Homey = require('homey');
 *
 * class MyDriver extends Homey.Driver {
 *   async onInit() {
 *     this.log('MyDriver has been initialized');
 *   }
 * }
 *
 * module.exports = MyDriver;
 */
declare class Driver extends SimpleClass {
    /**
     * When this method exists, it will be called prior to initing the device instance. Return a class that extends {@link Device}.
     * @function Driver#onMapDeviceClass
     * @param {Device} device - A temporary Device instance to check certain properties before deciding which class the device should use. This class will exist for a single tick, and does not support async methods.
     * @example
     * class MyDriver extends Homey.Driver {
     *
     *   onMapDeviceClass( device ) {
     *     if( device.hasCapability('dim') ) {
     *       return MyDeviceDim;
     *     } else {
     *       return MyDevice;
     *     }
     *   }
     * }
     */
    static isEqualDeviceData(deviceDataA: any, deviceDataB: any): boolean;
    id: string;
    /**
     * The Homey instance of this driver
     * @type {Homey}
     */
    homey: Homey;
    /**
     * The driver's manifest (app.json entry)
     * @type {any}
     */
    manifest: any;
    /**
     * Returns a promise which is resolved when the Driver is ready ({@link Driver#onInit} has been run).
     * @returns {Promise<void>} promise that is resolved when the Drivers Manager is ready
     */
    ready(): Promise<void>;
    /**
     * Get an Array with all {@link Device} instances
     * @returns {Device[]} Devices
     */
    getDevices(): Device[];
    /**
     * Get a Device instance by its deviceData object.
     * @param {object} deviceData Unique Device object as provided during pairing
     * @returns {Device} Device
     */
    getDevice(deviceData: object): Device;
    /**
     * Get the driver's discovery strategy when defined in the manifest
     * @returns {DiscoveryStrategy}
     */
    getDiscoveryStrategy(): DiscoveryStrategy;
    /**
     * This method is called when the driver is inited.
     */
    onInit(): Promise<void>;
    /**
     * This method is called when the driver is destroyed.
     */
    onUninit(): Promise<void>;
    /**
     * This method is called when a pair session starts.
     * @param {PairSession} session Bi-directional socket for communication with the front-end
     */
    onPair(session: PairSession): Promise<void>;
    /**
     * This method is called when a repair session starts.
     * @param {PairSession} session Bi-directional socket for communication with the front-end
     * @param {Device} The device being repaired
     */
    onRepair(session: PairSession, device: Device): Promise<void>;
    /**
     * This method is called when an unpair session starts.
     * @param {PairSession} session Bi-directional socket for communication with the front-end
     * @param {Device} The device being unpaired
     */
    onUnpair(session: PairSession, device: Device): Promise<void>;
    /**
     * This method is called when no custom onPair() method has been defined, and the default is being used.
     * Simple drivers should override this method to provide a list of devices ready to be paired.
     * @returns {Promise<any[]>}
     */
    onPairListDevices(): Promise<any[]>;
}
declare namespace Driver {
    export { Homey, DiscoveryStrategy, PairSession };
}
import SimpleClass = require("./SimpleClass.js");
type Homey = import('./Homey');
import Device = require("./Device.js");
type DiscoveryStrategy = import('./DiscoveryStrategy');
type PairSession = import('./PairSession');

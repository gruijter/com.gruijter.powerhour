export = ManagerBLE;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.ble`
 */
declare class ManagerBLE extends Manager {
    static ID: string;
    /**
     * Discovers BLE peripherals for a certain time
     *
     * > Requires the `homey:wireless:ble` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string[]} [serviceFilter] - List of required serviceUuids the peripheral should expose
     * @returns {Promise<BleAdvertisement[]>}
     */
    discover(serviceFilter?: string[] | undefined): Promise<BleAdvertisement[]>;
    /**
     * Finds a Ble peripheral with a given peripheralUuid
     *
     * > Requires the `homey:wireless:ble` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} peripheralUuid - The uuid of the peripheral to find
     * @returns {Promise<BleAdvertisement>}
     */
    find(peripheralUuid: string): Promise<BleAdvertisement>;
}
import Manager = require("../lib/Manager.js");
import BleAdvertisement = require("../lib/BleAdvertisement.js");

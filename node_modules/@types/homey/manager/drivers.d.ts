export = ManagerDrivers;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.drivers`
 */
declare class ManagerDrivers extends Manager {
    static ID: string;
    /**
     * Get a Driver instance by its ID
     * @param {string} driverId ID of the driver, as defined in app.json
     * @returns {Driver} Driver
     */
    getDriver(driverId: string): Driver;
    /**
     * Get an object with all {@link Driver} instances, with their ID as key
     * @returns {Object<string, Driver>} Drivers
     */
    getDrivers(): {
        [x: string]: Driver;
    };
}
import Manager = require("../lib/Manager.js");
import Driver = require("../lib/Driver.js");

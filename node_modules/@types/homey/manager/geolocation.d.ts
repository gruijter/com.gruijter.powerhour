export = ManagerGeolocation;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.geolocation`
 */
declare class ManagerGeolocation extends Manager {
    static ID: string;
    /**
     * Fired when the location is updated
     *
     * > Requires the `homey:manager:geolocation` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @event ManagerGeolocation#location
     */
    /**
     * Get the Homey's physical location's latitude
     *
     * > Requires the `homey:manager:geolocation` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {number} latitude
     */
    getLatitude(): number;
    /**
     * Get the Homey's physical location's longitude
     *
     * > Requires the `homey:manager:geolocation` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {number} longitude
     */
    getLongitude(): number;
    /**
     * Get the Homey's physical location's accuracy
     *
     * > Requires the `homey:manager:geolocation` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {number} accuracy (in meter)
     */
    getAccuracy(): number;
    /**
     * Get the Homey's physical mode
     *
     * > Requires the `homey:manager:geolocation` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {string} `auto` or `manual`
     */
    getMode(): string;
}
import Manager = require("../lib/Manager.js");

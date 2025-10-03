export = ManagerDiscovery;
/**
 * Discovery can be used to automatically find devices on the Homey's network. Usually, you don't want to use this manager directly, but link it automatically by using Drivers.
 * @see DiscoveryResultMDNSSD
 * @see DiscoveryResultSSDP
 * @see DiscoveryResultMAC
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.discovery`
 */
declare class ManagerDiscovery extends Manager {
    static ID: string;
    /**
     * @param {string} strategyId The ID as defined in your `app.json`
     * @returns {DiscoveryStrategy}
     */
    getStrategy(strategyId: string): DiscoveryStrategy;
}
import Manager = require("../lib/Manager.js");
import DiscoveryStrategy = require("../lib/DiscoveryStrategy.js");

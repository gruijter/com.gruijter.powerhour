export = ManagerArp;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.arp`
 */
declare class ManagerArp extends Manager {
    static ID: string;
    /**
     * Get an ip's MAC address
     * @param {string} ip
     * @returns {Promise<string>}
     */
    getMAC(ip: string): Promise<string>;
}
import Manager = require("../lib/Manager.js");

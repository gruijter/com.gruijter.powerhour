export = ManagerApps;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.apps`
 */
declare class ManagerApps extends Manager {
    static ID: string;
    /**
     * Check whether an app is installed, enabled and running.
     * @param {ApiApp} appInstance
     * @returns {Promise<boolean>}
     */
    getInstalled(appInstance: ApiApp): Promise<boolean>;
    /**
     * Get an installed app's version.
     * @param {ApiApp} appInstance
     * @returns {Promise<string>}
     */
    getVersion(appInstance: ApiApp): Promise<string>;
}
import Manager = require("../lib/Manager.js");
import ApiApp = require("../lib/ApiApp.js");

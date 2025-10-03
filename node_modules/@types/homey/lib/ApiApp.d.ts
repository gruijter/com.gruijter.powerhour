export = ApiApp;
/**
 * This class represents another App on Homey. When registered, realtime events are fired on the instance.
 * @extends Api
 * @example
 * let otherApp = this.homey.api.getApiApp('com.athom.otherApp');
 *
 * otherApp
 *   .on('realtime', (result) => console.log('otherApp.onRealtime', result))
 *   .on('install', (result) => console.log('otherApp.onInstall', result))
 *   .on('uninstall', (result) => console.log('otherApp.onUninstall', result));
 *
 * otherApp.get('/')
 *   .then((result) => console.log('otherApp.get', result))
 *   .catch((error) => this.error('otherApp.get', error));
 *
 * otherApp.getInstalled()
 *   .then((result) => console.log('otherApp.getInstalled', result))
 *   .catch((error) => this.error('otherApp.getInstalled', error));
 *
 * otherApp.getVersion()
 *   .then((result) => console.log('otherApp.getVersion', result))
 *   .catch((error) => this.error('otherApp.getVersion', error));
 */
declare class ApiApp extends Api {
    /**
     * This is a short-hand method to {@link ManagerApps#getInstalled}.
     * @returns {Promise<boolean>}
     */
    getInstalled(): Promise<boolean>;
    /**
     * This is a short-hand method to {@link ManagerApps#getVersion}.
     * @returns {Promise<string>}
     */
    getVersion(): Promise<string>;
}
import Api = require("./Api.js");

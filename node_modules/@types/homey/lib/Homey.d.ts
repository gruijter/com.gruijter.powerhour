export = Homey;
/**
 * @typedef {import('./App')} App
 * @typedef {import('../manager/apps')} ManagerApps
 * @typedef {import('../manager/arp')} ManagerArp
 * @typedef {import('../manager/audio')} ManagerAudio
 * @typedef {import('../manager/ble')} ManagerBLE
 * @typedef {import('../manager/cloud')} ManagerCloud
 * @typedef {import('../manager/clock')} ManagerClock
 * @typedef {import('../manager/dashboards')} ManagerDashboards
 * @typedef {import('../manager/drivers')} ManagerDrivers
 * @typedef {import('../manager/discovery')} ManagerDiscovery
 * @typedef {import('../manager/flow')} ManagerFlow
 * @typedef {import('../manager/geolocation')} ManagerGeolocation
 * @typedef {import('../manager/i18n')} ManagerI18n
 * @typedef {import('../manager/images')} ManagerImages
 * @typedef {import('../manager/insights')} ManagerInsights
 * @typedef {import('../manager/ledring')} ManagerLedring
 * @typedef {import('../manager/nfc')} ManagerNFC
 * @typedef {import('../manager/notifications')} ManagerNotifications
 * @typedef {import('../manager/rf')} ManagerRF
 * @typedef {import('../manager/settings')} ManagerSettings
 * @typedef {import('../manager/speech-input')} ManagerSpeechInput
 * @typedef {import('../manager/speech-output')} ManagerSpeechOutput
 * @typedef {import('../manager/zigbee')} ManagerZigBee
 * @typedef {import('../manager/zwave')} ManagerZwave
 * @typedef {import('../manager/api')} ManagerApi
*/
/**
 * The Homey instance holds all the Managers, System Events and generic properties.
 * You can access the Homey instance through `this.homey` on App, Driver and Device, it is also passed into your api handlers.
 * @extends SimpleClass
 * @example
 * // register system events
 * this.homey.on('memwarn', () => console.log('memwarn!'));
 *
 * // access a Manager
 * const latitude = this.homey.geolocation.{@link ManagerGeolocation#getLatitude|getLatitude}();
 * console.log('Latitude: ', latitude);
 */
declare class Homey extends SimpleClass {
    dir: string;
    tmpdir: string;
    /**
     * The software version of the Homey that is running this app
     * @type {string}
     */
    version: string;
    /**
     * The env.json environment variables
     * @type {any}
     */
    env: any;
    /**
     * The app.json manifest
     * @type {any}
     */
    manifest: any;
    /**
     * The platform of the Homey that is running this app
     * Note: on older software versions this might be undefined. In such case, assume it equals local.
     * @type {'cloud' | 'local'}
     */
    platform?: 'cloud' | 'local';
    /**
     * The platform version of the Homey that is running this app
     * Note: on older software versions this might be undefined. In such case, assume it equals 1.
     * @type {int}
     */
    platformVersion?: number;
    /**
     * A pointer to the App's instance.
     * @type {App}
     */
    app: App;
    /** @type {ManagerApps} */
    apps: ManagerApps;
    /** @type {ManagerArp} */
    arp: ManagerArp;
    /** @type {ManagerAudio} */
    audio: ManagerAudio;
    /** @type {ManagerBLE} */
    ble: ManagerBLE;
    /** @type {ManagerCloud} */
    cloud: ManagerCloud;
    /** @type {ManagerClock} */
    clock: ManagerClock;
    /** @type {ManagerDashboards} */
    dashboards: ManagerDashboards;
    /** @type {ManagerDrivers} */
    drivers: ManagerDrivers;
    /** @type {ManagerDiscovery} */
    discovery: ManagerDiscovery;
    /** @type {ManagerFlow} */
    flow: ManagerFlow;
    /** @type {ManagerGeolocation} */
    geolocation: ManagerGeolocation;
    /** @type {ManagerI18n} */
    i18n: ManagerI18n;
    /** @type {ManagerImages} */
    images: ManagerImages;
    /** @type {ManagerInsights} */
    insights: ManagerInsights;
    /** @type {ManagerLedring} */
    ledring: ManagerLedring;
    /** @type {ManagerNFC} */
    nfc: ManagerNFC;
    /** @type {ManagerNotifications} */
    notifications: ManagerNotifications;
    /** @type {ManagerRF} */
    rf: ManagerRF;
    /** @type {ManagerSettings} */
    settings: ManagerSettings;
    /** @type {ManagerSpeechInput} */
    speechInput: ManagerSpeechInput;
    /** @type {ManagerSpeechOutput} */
    speechOutput: ManagerSpeechOutput;
    /** @type {ManagerZigBee} */
    zigbee: ManagerZigBee;
    /** @type {ManagerZwave} */
    zwave: ManagerZwave;
    /** @type {ManagerApi} */
    api: ManagerApi;
    ready(): Promise<any>;
    markReady(): void;
    /**
     * @param {string} permission
     * @returns {boolean}
     */
    hasPermission(permission: string): boolean;
    /**
     * Shortcut to {@link ManagerI18n#__}
     *
     * @example
     * this.homey.__('errors.device_unavailable');
     * @example
     * this.homey.__({ en: 'My String', nl: 'Mijn tekst' });
     *
     * @param {string|Object} key translation string or Object
     * @param {Object=} tags values to interpolate into the translation
     * @returns {string}
     */
    __(key: string | Object, tags?: Object | undefined): string;
    /**
     * Alias to setTimeout that ensures the timout is correctly disposed
     * of when the Homey instance gets destroyed
     * @param {Function} callback
     * @param {number} ms
     * @param  {...any} args
     */
    setTimeout(callback: Function, ms: number, ...args: any[]): NodeJS.Timeout;
    /**
     * Alias to clearTimeout
     * @param {any} timeoutId
     */
    clearTimeout(timeoutId: any): void;
    /**
     * Alias to setInterval that ensures the interval is correctly disposed
     * of when the Homey instance gets destroyed
     * @param {Function} callback
     * @param {number} ms
     * @param  {...any} args
     */
    setInterval(callback: Function, ms: number, ...args: any[]): NodeJS.Timeout;
    /**
     * Alias to clearInterval
     * @param {any} timeoutId
     */
    clearInterval(timeoutId: any): void;
    destroy(): void;
}
declare namespace Homey {
    export { App, ManagerApps, ManagerArp, ManagerAudio, ManagerBLE, ManagerCloud, ManagerClock, ManagerDrivers, ManagerDiscovery, ManagerFlow, ManagerGeolocation, ManagerI18n, ManagerImages, ManagerInsights, ManagerLedring, ManagerNFC, ManagerNotifications, ManagerRF, ManagerSettings, ManagerSpeechInput, ManagerSpeechOutput, ManagerZigBee, ManagerZwave, ManagerApi };
}
import SimpleClass = require("./SimpleClass.js");
type App = import('./App');
type ManagerApps = import('../manager/apps');
type ManagerArp = import('../manager/arp');
type ManagerAudio = import('../manager/audio');
type ManagerBLE = import('../manager/ble');
type ManagerCloud = import('../manager/cloud');
type ManagerClock = import('../manager/clock');
type ManagerDashboards = import('../manager/dashboards');
type ManagerDrivers = import('../manager/drivers');
type ManagerDiscovery = import('../manager/discovery');
type ManagerFlow = import('../manager/flow');
type ManagerGeolocation = import('../manager/geolocation');
type ManagerI18n = import('../manager/i18n');
type ManagerImages = import('../manager/images');
type ManagerInsights = import('../manager/insights');
type ManagerLedring = import('../manager/ledring');
type ManagerNFC = import('../manager/nfc');
type ManagerNotifications = import('../manager/notifications');
type ManagerRF = import('../manager/rf');
type ManagerSettings = import('../manager/settings');
type ManagerSpeechInput = import('../manager/speech-input');
type ManagerSpeechOutput = import('../manager/speech-output');
type ManagerZigBee = import('../manager/zigbee');
type ManagerZwave = import('../manager/zwave');
type ManagerApi = import('../manager/api');

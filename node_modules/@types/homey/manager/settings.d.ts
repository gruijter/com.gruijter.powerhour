export = ManagerSettings;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.settings`
 */
declare class ManagerSettings extends Manager {
    static ID: string;
    /**
     * Get all settings keys.
     * @returns {String[]}
     */
    getKeys(): string[];
    /**
     * Get a setting.
     * @param {string} key
     * @returns {any} value
     */
    get(key: string): any;
    /**
     * Fires when a setting has been set.
     * @event ManagerSettings#set
     * @param {String} key
     */
    /**
     * Set a setting.
     * @param {string} key
     * @param {any} value
     */
    set(key: string, value: any): void;
    /**
     * Fires when a setting has been unset.
     * @event ManagerSettings#unset
     * @param {String} key
     */
    /**
     * Unset (delete) a setting.
     * @param {string} key
     */
    unset(key: string): void;
}
import Manager = require("../lib/Manager.js");

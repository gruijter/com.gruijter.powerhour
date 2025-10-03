export = ManagerI18n;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.i18n`
 */
declare class ManagerI18n extends Manager {
    static ID: string;
    /**
     * Translate a string, as defined in the app's `/locales/<language>.json` file.
     * This method is also available at @{link Homey#__}
     * @param {string} key
     * @param {object} tags - An object of tags to replace. For example, in your json define `Hello, __name__!`. The property *name* would contain a string, e.g. *Dave*.
     * @returns {string} The translated string
     * @example <caption>/locales/en.json</caption>
     * { "welcome": "Welcome, __name__!" }
     * @example <caption>/app.js</caption>
     * let welcomeMessage = this.homey.__('welcome', { name: 'Dave' });
     * console.log( welcomeMessage ); // "Welcome, Dave!"
     */
    __(key: string, tags: object): string;
    /**
     * Get Homey's current language
     * @returns {string} The language as a 2-character string (e.g. `en`)
     */
    getLanguage(): string;
    /**
     * Get Homey's current units
     * @returns {string} `metric` or `imperial`
     */
    getUnits(): string;
    getStrings(): any;
}
import Manager = require("../lib/Manager.js");

export = HomeySettings;
/**
 * HomeySettings is the interface for the Homey instance
 * used to communicate with Homey from an app settings page.
 * It is the type of the argument in the `onHomeyReady` function.
 */
interface HomeySettings {
    /**
     * Translate a string programmatically.
     *
     * @example
     * Homey.__('errors.device_unavailable');
     * @example
     * Homey.__({ en: 'My String', nl: 'Mijn tekst' });
     *
     * @param {object|string} key translation string or Object
     * @param {object} [tags] values to interpolate into the translation
     * @returns {string}
     */
    __(key: object | string, tags?: object): string;
    /**
     * Make a DELETE or GET call to the app's web API.
     * @param {'DELETE'|'GET'} method
     * @param {string} uri
     * @param {null} [body]
     * @param {Function} callback
     */
    api(method: 'DELETE' | 'GET', uri: string, callback: Function): void;
    api(method: 'DELETE' | 'GET', uri: string, body: null, callback: Function): void;
    /**
     * Make a POST or PUT call to the app's web API.
     * @param {'POST'|'PUT'} method
     * @param {string} uri
     * @param {any} body
     * @param {Function} callback
     */
    api(method: 'POST' | 'PUT', uri: string, body: any, callback: Function): void;
    /**
     * Show an alert dialog.
     * @param {string} key
     */
    alert(key: string): Promise<void>;
    /**
     * Show a confirm dialog.
     * The callback's second argument will be true if the user presses OK.
     * @param {string} key
     * @param {string|null} icon
     * @param {Function} callback
     */
    confirm(key: string, icon: string | null, callback: Function): void;
    /**
     * Get an object with all settings.
     * @param {Function} callback
     * @returns {any}
     */
    get(callback: Function): any;
    /**
     * Get a single setting's value.
     * @param {string} key
     * @param {Function} callback
     * @returns {any}
     */
    get(key: string, callback: Function): any;
    /**
     * Register an event listener for the app's realtime events.
     * System events when modifying settings are: 'settings.set', 'settings.unset'.
     * @param {string} event
     * @param {Function} callback
     */
    on(event: string, callback: Function): void;
    /**
     * Show a new window.
     * @param {string} url
     */
    openURL(url: string): Promise<void>;
    /**
     * The settings view will be hidden until this method has been called.
     * Use the extra time to make required API calls to prevent flickering on screen.
     */
    ready(): void;
    /**
     * Set a single setting's value. The value must be JSON-serializable.
     * @param {string} key
     * @param {any} value
     * @param {Function} callback
     */
    set(key: string, value: any, callback: Function): void;
    /**
     * Unset a single setting's value.
     * @param {string} key
     * @param {Function} callback
     */
    unset(key: string, callback: Function): void;
}

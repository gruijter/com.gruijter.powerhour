export = HomeyWidget;
/**
 * HomeyWidget is the interface for the Homey instance
 * used to communicate with Homey from an app widget.
 * It is the type of the argument in the `onHomeyReady` function.
 */
interface HomeyWidget {
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
     * Make a call to the widget's web API.
     * @param {'DELETE'|'GET'|'POST'|'PUT'} method
     * @param {string} uri
     * @param {object} [body]
     */
    api(
        method: 'DELETE' | 'GET' | 'POST' | 'PUT',
        uri: string,
        body?: object,
    ): Promise<unknown>;
    /**
     * Get an object with all settings.
     * @returns {Object.<string, unknown>}
     */
    getSettings(): Record<string, unknown>;
    /**
     * Get the unique id for the instance of the widget.
     * @returns {string}
     */
    getWidgetInstanceId(): string;
    /**
     * Provide a haptic feedback on presses.
     * This function can only be called in a short window after a touch event.
     */
    hapticFeedback(): void;
    /**
     * Register an event listener for the app's realtime events.
     * @param {string} event
     * @param {Function} callback
     */
    on(event: string, callback: Function): void;
    /**
     * Open an in app browser view.
     * @param {string} url
     */
    popup(url: string): Promise<void>;
    /**
     * The settings view will be hidden until this method has been called.
     * Use the extra time to make required API calls to prevent flickering on screen.
     * @param {Object} [args] An object with a height property.
     * @param {number|string} [args.height] The height of the widget.
     */
    ready(args?: { height: number | string }): void;
    /**
     * Change the widget height during runtime.
     * @param {number|string|null} height
     */
    setHeight(height: number | string | null): Promise<void>;
}

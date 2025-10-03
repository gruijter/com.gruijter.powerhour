export = ManagerApi;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.api`
 */
declare class ManagerApi extends Manager {
    static ID: string;
    /**
     * Perform a GET request.
     * @param {string} uri - The path to request, relative to /api.
     * @returns {Promise<any>}
     */
    get(uri: string): Promise<any>;
    /**
     * Perform a POST request.
     * @param {string} uri - The path to request, relative to /api.
     * @param {any} body - The body of the request.
     * @returns {Promise<any>}
     */
    post(uri: string, body: any): Promise<any>;
    /**
     * Perform a PUT request.
     * @param {string} uri - The path to request, relative to /api.
     * @param {any} body - The body of the request.
     * @returns {Promise<any>}
     */
    put(uri: string, body: any): Promise<any>;
    /**
     * Perform a DELETE request.
     * @param {string} uri - The path to request, relative to /api.
     * @returns {Promise<any>}
     */
    delete(uri: string): Promise<any>;
    /**
     * Emit a `realtime` event.
     * @param {string} event - The name of the event
     * @param {any} data - The data of the event
     */
    realtime(event: string, data: any): any;
    /**
     * Create an {@link Api} instance, to receive realtime events.
     * @param {string} uri The URI of the endpoint, e.g. `homey:manager:webserver`
     * @returns {Api}
     */
    getApi(uri: string): Api;
    hasApi(uri: any): boolean;
    /**
     * Create an {@link ApiApp} instance, to receive realtime events.
     * @param {string} appId The ID of the App, e.g. `com.athom.foo`
     * @returns {ApiApp}
     */
    getApiApp(appId: string): ApiApp;
    hasApiApp(appId: any): boolean;
    /**
     * Unregister an {@link Api} instance.
     * @param {Api} api
     */
    unregisterApi(api: Api): void;
    /**
     * Starts a new API session on behalf of the homey owner and returns the API token.
     * The API Token expires after not being used for two weeks.
     *
     * > Requires the `homey:manager:api` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {Promise<string>}
     */
    getOwnerApiToken(): Promise<string>;
    /**
     * Returns the url for local access.
     *
     * > Requires the `homey:manager:api` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @returns {Promise<string>}
     */
    getLocalUrl(): Promise<string>;
}
import Manager = require("../lib/Manager.js");
import Api = require("../lib/Api.js");
import ApiApp = require("../lib/ApiApp.js");

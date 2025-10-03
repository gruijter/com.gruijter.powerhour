export = Api;
/**
 * This class represents an API endpoint on Homey. When registered, realtime events are fired on the instance.
 */
declare class Api extends events.EventEmitter {
    type: string;
    id: string;
    /**
     * Perform a GET request.
     * @param {string} uri - The path to request, relative to the endpoint.
     * @returns {Promise<any>}
     */
    get(uri: string): Promise<any>;
    /**
     * Perform a POST request.
     * @param {string} uri - The path to request, relative to the endpoint.
     * @param {any} body - The body of the request.
     * @returns {Promise<any>}
     */
    post(uri: string, body: any): Promise<any>;
    /**
     * Perform a PUT request.
     * @param {string} uri - The path to request, relative to the endpoint.
     * @param {any} body - The body of the request.
     * @returns {Promise<any>}
     */
    put(uri: string, body: any): Promise<any>;
    /**
     * Perform a DELETE request.
     * @param {string} uri - The path to request, relative to the endpoint.
     * @returns {Promise<any>}
     */
    delete(uri: string): Promise<any>;
    /**
     * Unregister the API.
     * This is a shorthand method for {@link ManagerApi#unregisterApi}.
     */
    unregister(): void;
}
import events = require("events");
